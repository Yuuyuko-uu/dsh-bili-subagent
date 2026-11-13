#      ⑩ `bili_dm_recent` 读私信（分享卡片 msg_type=7/8 要特殊解析；不做身份过滤，交给宿主）
#      ⑪ `bili_dm_sessions` 看私信会话列表（谁发过、几个没读）—— 宿主先问未读、再只读有新消息的那几个
#!/usr/bin/env python3
"""
Bilibili MCP Server
B站数据采集 MCP 服务，支持 OpenClaw / Claude Code / Cursor / Cline

功能：搜索视频、抓取评论、获取字幕、弹幕、回复评论
首次运行需扫码登录B站，凭证自动保存复用
"""

# ⭐ 这个文件是从上游 AGI_Ananas/bilibili-mcp（MIT，见同目录 LICENSE）vendor 进来的。
#    本插件在它上面只加了下面这几处 —— **将来重新 vendor 时，这几处要原样补回来**（漏一处就少一道闸 ✗）：
#      ① `_ALLOWED` + `tool()` 白名单替身：工具按名单注册，名单外的连名字都不出现（见下）
#      ② `load_credential` 读取容错 + encoding="utf-8" + isinstance(data, dict) 校验
#      ③ 登录成功后凭证**原子写**（先写 .tmp 再 os.replace）
#      ④ `bili_comments` 把抓取异常带进返回（风控 -412 不再伪装成"这条视频 0 条评论"）
#      ⑤ `bili_reply` 回执带上 `rpid` / `rpid_str` / `root` / `parent`（判重表与评论复核要用）
#      ⑥ 收到的 @ / 回复两只工具**把条目整理成统一形状**（带 bvid、昵称、正文、rpid、root），
#         宿主好直接递给人看 —— 原始 msgfeed 的字段名和 business_id 太绕，别让宿主去猜
#      ⑦ `bili_reply` 的 `bvid` 参数**也接受纯数字 aid**（通知里常常只有 aid；对外参数名不变）
import asyncio
import json
import base64
import os
import re
import sys
import tempfile
from pathlib import Path
from mcp.server.fastmcp import FastMCP

from bilibili_api import video, search, comment, Credential, dynamic, opus
from bilibili_api import hot, rank, user, session, favorite_list
from bilibili_api.video_uploader import (
    VideoUploader, VideoUploaderPage, VideoMeta, Lines,
)
from bilibili_api.utils.picture import Picture
from bilibili_api.login_v2 import QrCodeLogin, QrCodeLoginEvents

# ========== 初始化 ==========

CRED_FILE = Path(__file__).parent / "bili_credential.json"

mcp = FastMCP("bilibili-mcp")

# ⭐ 工具白名单（2026-10-17 审查里的 H3）：宿主通过 overlay 的 env 下发 BILI_MCP_TOOLS（逗号分隔）。
#    · 不给这个变量 ⇒ **全放**（手工跑、或老配置，行为一点不变 ✓）
#    · 给了 ⇒ 只注册名单里的；不在名单里的工具**连名字都不会出现在 list_tools 里**，
#      模型那边等于根本不存在 —— 这才是真的闸门（光靠提示词说"别用"不算）✓
_ALLOWED = {t.strip() for t in os.environ.get("BILI_MCP_TOOLS", "").split(",") if t.strip()}


# ⭐ 0.9.9：判重表要**读**，不能只写。
#    ⚠️ 0.9.7 让插件在轮末往「## 看过的视频」里记，但**没有任何代码读它**：
#       `bili_search` 照旧把同一批热门视频端上来，子代理照旧挑中同一条 ——
#       「判重」等于没有（实测：同一个视频被推了 9 次、评论 @ 了 9 次）。
#       所以这里补两件事：搜索时**过滤**掉表里已有的；评论/三连之后**立刻记账**，
#       让"伙伴自己挑"那条路（不走插件轮末记账）也能进表。
SEEN_FILE = Path(__file__).parent / "seen.md"
_SEEN_BV_RE = re.compile(r"BV[0-9A-Za-z]{10}")
_SEEN_HEADER = (
    "# 刷B站 · 判重表（宿主预建，那一轮只往后面追加）\n\n"
    "## 评论记录（BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字）\n\n"
    "| BV | rpid | root（楼中楼才填） | 时间 | 正文前 20 字 |\n"
    "| --- | --- | --- | --- | --- |\n\n"
    "## 看过的视频\n"
)


def _seen_bvs() -> set:
    """表里出现过的所有 BV（评论过的 + 刷过的都算）"""
    try:
        if not SEEN_FILE.exists():
            return set()
        return set(_SEEN_BV_RE.findall(SEEN_FILE.read_text(encoding="utf-8")))
    except OSError:
        return set()


def _seen_append(line: str) -> None:
    try:
        if not SEEN_FILE.exists():
            SEEN_FILE.write_text(_SEEN_HEADER, encoding="utf-8")
        with open(SEEN_FILE, "a", encoding="utf-8") as f:
            f.write(line.rstrip("\n") + "\n")
    except OSError as e:
        print(f"[bili-mcp] 判重表写不进去：{e}", file=sys.stderr)


def _seen_note_comment(bvid: str, rpid, text: str, root=None) -> None:
    """评论记录要写进「## 评论记录」那张表里，不能甩到文件末尾 ——
    `lib/verify.mjs` 虽然容错，但表坏了以后人工看就分不清哪行是哪节。"""
    import time as _t
    when = _t.strftime("%Y-%m-%d %H:%M", _t.localtime())
    body = " ".join(str(text or "").split())[:20].replace("|", "／")
    row = f"| {bvid} | {rpid or ''} | {root or ''} | {when} | {body} |"
    try:
        if not SEEN_FILE.exists():
            SEEN_FILE.write_text(_SEEN_HEADER, encoding="utf-8")
        行们 = SEEN_FILE.read_text(encoding="utf-8").split("\n")
        起 = next((i for i, l in enumerate(行们) if l.strip().startswith("## 评论记录")), None)
        if 起 is None:
            _seen_append(row)
            return
        插 = 起 + 1
        for i in range(起 + 1, len(行们)):
            if 行们[i].startswith("## "):
                break
            if 行们[i].lstrip().startswith("|"):
                插 = i + 1
        行们.insert(插, row)
        SEEN_FILE.write_text("\n".join(行们), encoding="utf-8")
    except OSError as e:
        print(f"[bili-mcp] 判重表写不进去：{e}", file=sys.stderr)


def _seen_note_video(bvid: str) -> None:
    import time as _t
    if not _SEEN_BV_RE.fullmatch(str(bvid or "")):
        return
    _seen_append("- " + bvid + " " + _t.strftime("%Y-%m-%d"))


def tool():
    """@tool() 的替身：白名单里没有这个函数名，就原样返回、**不注册**。"""
    def deco(fn):
        if _ALLOWED and fn.__name__ not in _ALLOWED:
            return fn
        return mcp.tool()(fn)
    return deco


def load_credential() -> Credential:
    """从文件加载凭证"""
    if not CRED_FILE.exists():
        return None
    try:
        with open(CRED_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        # ⚠️ 文件写坏一次（上一次写被打断）会让**所有**工具一起 JSONDecodeError：
        #    这里退化成「没登录」，重新扫一次码就能恢复。（2026-10-16 审查修）
        print(f"[bili-mcp] 凭证读不了（{type(e).__name__}: {e}）：{CRED_FILE}", file=sys.stderr)
        return None
    if not isinstance(data, dict):
        return None
    return Credential(
        sessdata=data.get("sessdata", ""),
        bili_jct=data.get("bili_jct", ""),
        buvid3=data.get("buvid3") or "",
        dedeuserid=data.get("dedeuserid", ""),
    )


# ========== 登录会话（进程级缓存） ==========

_login_session: QrCodeLogin | None = None


def get_cred() -> Credential:
    """获取凭证，未登录时引导用户调用 bili_login"""
    cred = load_credential()
    if not cred:
        raise Exception("未登录B站！请先调用 bili_login 工具获取登录二维码，让用户扫码登录。")
    return cred


# ========== Tool: 扫码登录（生成二维码） ==========

@tool()
async def bili_login() -> str:
    """
    生成B站登录二维码，返回二维码图片（base64）供用户扫码。
    用户扫码后，调用 bili_login_check 检查登录状态。

    Returns:
        包含二维码base64图片数据的JSON，前端可直接渲染为图片展示给用户
    """
    global _login_session

    # 如果已有凭证，直接返回
    cred = load_credential()
    if cred:
        return json.dumps({
            "status": "already_logged_in",
            "message": "已登录B站，无需重复登录",
        }, ensure_ascii=False)

    # 生成新的登录会话
    _login_session = QrCodeLogin()
    await _login_session.generate_qrcode()

    # 获取二维码图片的 base64（无损PNG）
    pic = _login_session.get_qrcode_picture()
    img_base64 = base64.b64encode(pic.content).decode("utf-8")

    # 保存二维码图片到项目根目录
    qr_file = Path(__file__).parent / "qrcode_login.png"
    with open(qr_file, "wb") as f:
        f.write(pic.content)

    # 获取终端文本版二维码（纯文本客户端备用）
    terminal_qr = _login_session.get_qrcode_terminal()

    # 获取原始扫码URL（用户也可以手动在B站App打开）
    qr_url = getattr(_login_session, "_QrCodeLogin__qr_link", "")

    return json.dumps({
        "status": "qrcode_ready",
        "message": "请用B站App扫描二维码登录（180秒内有效）",
        "qrcode_image": f"data:image/png;base64,{img_base64}",
        "qrcode_file": str(qr_file),
        "qrcode_terminal": terminal_qr,
        "qrcode_url": qr_url,
        "next_step": "用户扫码后，请调用 bili_login_check 检查登录状态",
    }, ensure_ascii=False)


# ========== Tool: 检查登录状态 ==========

@tool()
async def bili_login_check() -> str:
    """
    检查B站扫码登录状态。在用户扫码后调用此工具。
    如果返回 "scanning" 或 "confirming"，请等待几秒后再次调用。
    如果返回 "done"，登录成功，可以使用其他工具了。
    如果返回 "timeout"，需要重新调用 bili_login 生成新二维码。

    Returns:
        当前登录状态
    """
    global _login_session

    if not _login_session:
        # 没有登录会话，检查是否已登录
        cred = load_credential()
        if cred:
            return json.dumps({
                "status": "already_logged_in",
                "message": "已登录B站",
            }, ensure_ascii=False)
        return json.dumps({
            "status": "no_session",
            "message": "没有进行中的登录，请先调用 bili_login 生成二维码",
        }, ensure_ascii=False)

    state = await _login_session.check_state()

    if state == QrCodeLoginEvents.SCAN:
        return json.dumps({
            "status": "scanning",
            "message": "已扫码，等待用户在手机上确认...",
            "next_step": "请等待3秒后再次调用 bili_login_check",
        }, ensure_ascii=False)

    elif state == QrCodeLoginEvents.CONF:
        return json.dumps({
            "status": "confirming",
            "message": "用户已确认，正在处理...",
            "next_step": "请等待2秒后再次调用 bili_login_check",
        }, ensure_ascii=False)

    elif state == QrCodeLoginEvents.TIMEOUT:
        _login_session = None
        # 清理二维码文件
        qr_file = Path(__file__).parent / "qrcode_login.png"
        if qr_file.exists():
            qr_file.unlink()
        return json.dumps({
            "status": "timeout",
            "message": "二维码已过期，请重新调用 bili_login 生成新二维码",
        }, ensure_ascii=False)

    elif state == QrCodeLoginEvents.DONE:
        # 登录成功，保存凭证
        cred = _login_session.get_credential()
        # ⚠️ 原子写：原来直接 open(w) 先截断再 dump，写到一半被打断就毁掉旧凭证，
        #    此后所有工具都读不了。（2026-10-16 审查修）
        tmp_cred = CRED_FILE.with_name(CRED_FILE.name + ".tmp")
        with open(tmp_cred, "w", encoding="utf-8") as f:
            json.dump({
                "sessdata": cred.sessdata,
                "bili_jct": cred.bili_jct,
                "buvid3": cred.buvid3,
                "dedeuserid": cred.dedeuserid,
            }, f)
        os.replace(tmp_cred, CRED_FILE)
        _login_session = None
        # 清理二维码文件
        qr_file = Path(__file__).parent / "qrcode_login.png"
        if qr_file.exists():
            qr_file.unlink()
        return json.dumps({
            "status": "done",
            "message": "登录成功！凭证已保存，现在可以使用所有B站功能了",
        }, ensure_ascii=False)

    return json.dumps({
        "status": "unknown",
        "message": f"未知状态: {state}",
    }, ensure_ascii=False)


# ========== Tool: 登录状态查询 ==========

@tool()
async def bili_check_credential() -> str:
    """
    检查当前B站登录凭证是否有效

    Returns:
        登录状态信息
    """
    cred = load_credential()
    if not cred:
        return json.dumps({
            "logged_in": False,
            "message": "未登录，请调用 bili_login 进行扫码登录",
        }, ensure_ascii=False)

    # 尝试用凭证请求一下，验证是否过期
    try:
        my_info = await user.User(
            uid=int(cred.dedeuserid), credential=cred
        ).get_user_info()
        return json.dumps({
            "logged_in": True,
            "uid": cred.dedeuserid,
            "username": my_info.get("name", ""),
            "message": "凭证有效",
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({
            "logged_in": False,
            "message": f"凭证可能已过期: {str(e)}，请重新调用 bili_login 登录",
        }, ensure_ascii=False)


# ========== Tool 1: 搜索视频 ==========

@tool()
async def bili_search(keyword: str, num: int = 10, order: str = "totalrank") -> str:
    """
    搜索B站视频

    Args:
        keyword: 搜索关键词，如"AI Agent"、"大模型教程"
        num: 返回视频数量，默认10，最大50
        order: 排序方式 totalrank=综合 click=播放量 pubdate=最新 dm=弹幕
    
    Returns:
        JSON格式的视频列表，包含标题、BV号、播放量、评论数、UP主等
    """
    order_map = {
        "totalrank": search.OrderVideo.TOTALRANK,
        "click": search.OrderVideo.CLICK,
        "pubdate": search.OrderVideo.PUBDATE,
        "dm": search.OrderVideo.DM,
    }
    order_enum = order_map.get(order, search.OrderVideo.TOTALRANK)

    result = await search.search_by_type(
        keyword=keyword,
        search_type=search.SearchObjectType.VIDEO,
        page=1,
        order_type=order_enum,
    )

    videos = []
    for item in result.get("result", [])[:num]:
        title = item.get("title", "").replace('<em class="keyword">', "").replace("</em>", "")
        videos.append({
            "bvid": item.get("bvid", ""),
            "aid": item.get("aid", 0),
            "title": title,
            "author": item.get("author", ""),
            "play": item.get("play", 0),
            "review": item.get("review", 0),
            "danmaku": item.get("video_review", 0),
            "duration": item.get("duration", ""),
            # ⭐ 发布时间（unix 秒）：宿主拿它做「至少发布 N 天」的硬门槛（2026-10-19 加）
            "pubdate": item.get("pubdate", 0),
            "description": item.get("description", "")[:200],
        })

    # ⭐ 0.9.9：过滤掉判重表里已有的
    #    （否则 click 排序每轮返回的前十条基本不变，等于每轮都从同一口锅里舀）
    seen = _seen_bvs()
    挡掉 = 0
    if seen:
        before = len(videos)
        videos = [v for v in videos if v.get("bvid") not in seen]
        挡掉 = before - len(videos)
        if 挡掉:
            print(f"[bili-mcp] 判重表挡掉 {挡掉} 条刷过的", file=sys.stderr)

    return json.dumps({"keyword": keyword, "count": len(videos), "filtered_seen": 挡掉,
                       "videos": videos}, ensure_ascii=False)


# ========== Tool 2: 获取评论 ==========

@tool()
async def bili_comments(bvid: str, num: int = 30) -> str:
    """
    获取B站视频的热门评论

    Args:
        bvid: 视频BV号，如"BV1uNk1YxEJQ"
        num: 获取评论数量，默认30
    
    Returns:
        JSON格式的评论列表，包含用户名、评论内容、点赞数、回复数
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    aid = info["aid"]

    comments = []
    page = 1
    fetch_error = None
    while len(comments) < num:
        try:
            resp = await comment.get_comments(
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                page_index=page,
                order=comment.OrderType.LIKE,
                credential=cred,
            )
            replies = resp.get("replies") or []
            if not replies:
                break

            for r in replies:
                member = r.get("member", {})
                content = r.get("content", {})
                c = {
                    "rpid": r.get("rpid", 0),
                    "user": member.get("uname", ""),
                    "content": content.get("message", ""),
                    "like": r.get("like", 0),
                    "reply_count": r.get("rcount", 0),
                    "time": r.get("ctime", 0),
                }
                # 子评论
                sub_replies = []
                for sub in (r.get("replies") or [])[:2]:
                    sub_replies.append({
                        "user": sub.get("member", {}).get("uname", ""),
                        "content": sub.get("content", {}).get("message", ""),
                        "like": sub.get("like", 0),
                    })
                if sub_replies:
                    c["top_replies"] = sub_replies
                comments.append(c)

            page += 1
            await asyncio.sleep(0.5)
        except Exception as e:
            # ⚠️ 抓取失败（风控 -412 / 网络错）不能吞成「这条视频 0 条评论」：
            #    调用方必须能分辨「真没评论」和「没抓到」，否则日报静默失真。（2026-10-16 审查修）
            fetch_error = f"{type(e).__name__}: {e}"
            break

    out = {"bvid": bvid, "count": len(comments[:num]), "comments": comments[:num]}
    if fetch_error:
        out["error"] = fetch_error
    return json.dumps(out, ensure_ascii=False)


# ========== Tool 3: 获取字幕 ==========

@tool()
async def bili_subtitle(bvid: str) -> str:
    """
    获取B站视频的AI字幕（语音转文字）

    Args:
        bvid: 视频BV号，如"BV1uNk1YxEJQ"
    
    Returns:
        视频的完整字幕文本
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)

    info = await v.get_info()
    cid = info.get("cid", 0)
    if not cid and info.get("pages"):
        cid = info["pages"][0].get("cid", 0)

    if not cid:
        return json.dumps({"error": "无法获取cid"}, ensure_ascii=False)

    subtitle_list = await v.get_subtitle(cid=cid)
    subtitles = subtitle_list.get("subtitles", [])

    if not subtitles:
        return json.dumps({"message": "该视频没有字幕"}, ensure_ascii=False)

    # 优先AI中文字幕
    target = None
    for s in subtitles:
        if s.get("lan") in ["ai-zh", "zh-CN", "zh"]:
            target = s
            break
    if not target:
        target = subtitles[0]

    # 下载字幕
    import aiohttp
    sub_url = target.get("subtitle_url", "")
    if sub_url.startswith("//"):
        sub_url = "https:" + sub_url

    async with aiohttp.ClientSession() as session:
        async with session.get(sub_url) as resp:
            sub_data = await resp.json()

    texts = [item.get("content", "") for item in sub_data.get("body", [])]
    full_text = "\n".join(texts)

    return json.dumps({
        "bvid": bvid,
        "title": info.get("title", ""),
        "language": target.get("lan_doc", ""),
        "segments": len(texts),
        "text": full_text,
    }, ensure_ascii=False)


# ========== Tool 4: 获取弹幕 ==========

@tool()
async def bili_danmaku(bvid: str, num: int = 100) -> str:
    """
    获取B站视频的弹幕

    Args:
        bvid: 视频BV号
        num: 获取弹幕数量，默认100
    
    Returns:
        弹幕列表，包含弹幕文本和出现时间
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)

    danmakus = await v.get_danmakus(page_index=0)
    result = []
    for d in danmakus[:num]:
        result.append({
            "text": d.text,
            "time": d.dm_time,
        })

    return json.dumps({"bvid": bvid, "count": len(result), "danmakus": result}, ensure_ascii=False)


# ========== Tool 5: 视频详情 ==========

@tool()
async def bili_video_info(bvid: str) -> str:
    """
    获取B站视频的详细信息

    Args:
        bvid: 视频BV号
    
    Returns:
        视频标题、描述、UP主、播放量、评论数、收藏数等详细数据
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    stat = info.get("stat", {})

    return json.dumps({
        "bvid": info.get("bvid"),
        "aid": info.get("aid"),
        "title": info.get("title"),
        "description": info.get("desc"),
        "author": info.get("owner", {}).get("name"),
        "duration": info.get("duration"),
        "pages": len(info.get("pages", [])),
        "tags": [t.get("tag_name") for t in info.get("tag", []) if t.get("tag_name")],
        "stat": {
            "view": stat.get("view", 0),
            "danmaku": stat.get("danmaku", 0),
            "reply": stat.get("reply", 0),
            "favorite": stat.get("favorite", 0),
            "coin": stat.get("coin", 0),
            "like": stat.get("like", 0),
            "share": stat.get("share", 0),
        },
    }, ensure_ascii=False)


# ========== Tool 6: 回复评论 ==========

@tool()
async def bili_reply(bvid: str, text: str, rpid: int = 0, root: int = 0) -> str:
    """
    在B站视频下发表评论或回复某条评论

    Args:
        bvid: 视频BV号
        text: 评论/回复的文本内容
        rpid: 要回复的目标评论ID（0表示发表新评论）
        root: 楼层根评论ID（回复一级评论时不用填，回复楼中楼时填根评论ID）
    
    Returns:
        发表结果
    """
    cred = get_cred()
    # 纯数字 = aid（消息通知里常常只给 aid）。对外参数名不变，内部转一下。
    bvid = str(bvid or "").strip()
    if bvid.isdigit():
        try:
            from bilibili_api.utils.aid_bvid_transformer import aid2bvid
            bvid = str(aid2bvid(int(bvid)))
        except Exception:
            pass
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    aid = info["aid"]

    try:
        if rpid == 0:
            # 发表新评论
            result = await comment.send_comment(
                text=text,
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                credential=cred,
            )
        else:
            # 回复评论
            # root=0 表示回复一级评论，root=rpid
            # root!=0 表示回复楼中楼，root=根评论，parent=目标评论
            actual_root = root if root != 0 else rpid
            result = await comment.send_comment(
                text=text,
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                root=actual_root,
                parent=rpid,
                credential=cred,
            )

        # ⭐ 把回执里的 rpid 带回去：判重表要靠它记「我们发过哪条」，宿主的评论复核
        #    （lib/verify.mjs）也要拿它去 B站 查公开可见性。只回 success 的话那条链是断的。
        #（2026-10-16 审查修：原实现把上面的 result 丢掉了）
        out = {"success": True, "message": "评论发送成功"}
        if isinstance(result, dict):
            for key in ("rpid", "rpid_str", "root", "parent"):
                val = result.get(key)
                if isinstance(val, (int, str)) and str(val).strip() and str(val) != "0":
                    out[key] = val
        # ⭐ 0.9.9：发完立刻记账 —— 下一轮 bili_search 就不会再端上来
        _seen_note_comment(bvid, out.get("rpid") or out.get("rpid_str"), text,
                           root=root or (rpid if rpid else None))
        _seen_note_video(bvid)
        return json.dumps(out, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ========== Tool 7: 批量采集 ==========

@tool()
async def bili_crawl(keyword: str, max_videos: int = 5, comments_per_video: int = 20, get_subtitles: bool = True) -> str:
    """
    批量采集：搜索B站视频并抓取每个视频的评论和字幕

    Args:
        keyword: 搜索关键词
        max_videos: 最多采集视频数，默认5
        comments_per_video: 每个视频采集评论数，默认20
        get_subtitles: 是否获取字幕，默认True
    
    Returns:
        包含视频信息、评论和字幕的完整采集数据
    """
    cred = get_cred()

    # 搜索
    search_result = await search.search_by_type(
        keyword=keyword,
        search_type=search.SearchObjectType.VIDEO,
        page=1,
        order_type=search.OrderVideo.TOTALRANK,
    )

    results = []
    for item in search_result.get("result", [])[:max_videos]:
        bvid = item.get("bvid", "")
        if not bvid:
            continue

        title = item.get("title", "").replace('<em class="keyword">', "").replace("</em>", "")
        video_data = {
            "bvid": bvid,
            "title": title,
            "author": item.get("author", ""),
            "play": item.get("play", 0),
            "review": item.get("review", 0),
        }

        # 评论
        comments_json = await bili_comments(bvid=bvid, num=comments_per_video)
        comments_data = json.loads(comments_json)

        # 字幕
        subtitle_text = ""
        if get_subtitles:
            try:
                subtitle_json = await bili_subtitle(bvid=bvid)
                subtitle_data = json.loads(subtitle_json)
                subtitle_text = subtitle_data.get("text", "")
            except:
                pass

        results.append({
            "video": video_data,
            "comments": comments_data.get("comments", []),
            "subtitle_text": subtitle_text,
        })

        await asyncio.sleep(1)

    return json.dumps({
        "keyword": keyword,
        "video_count": len(results),
        "total_comments": sum(len(r["comments"]) for r in results),
        "results": results,
    }, ensure_ascii=False)


# ========== 辅助：封面处理 ==========

import subprocess


def _extract_cover_from_video(video_path: str) -> Picture:
    """从视频第3秒截取一帧作为封面，返回 Picture 对象"""
    tmp_cover = os.path.join(tempfile.gettempdir(), f"bili_cover_{os.getpid()}.png")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-ss", "3", "-i", video_path,
             "-vframes", "1", "-q:v", "2", tmp_cover],
            capture_output=True, timeout=30,
        )
        if os.path.isfile(tmp_cover) and os.path.getsize(tmp_cover) > 0:
            return Picture.from_file(tmp_cover)
    finally:
        if os.path.isfile(tmp_cover):
            os.remove(tmp_cover)
    # fallback: 第0秒
    tmp_cover2 = os.path.join(tempfile.gettempdir(), f"bili_cover2_{os.getpid()}.png")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-ss", "0", "-i", video_path,
             "-vframes", "1", "-q:v", "2", tmp_cover2],
            capture_output=True, timeout=30,
        )
        if os.path.isfile(tmp_cover2) and os.path.getsize(tmp_cover2) > 0:
            return Picture.from_file(tmp_cover2)
    finally:
        if os.path.isfile(tmp_cover2):
            os.remove(tmp_cover2)
    raise RuntimeError(f"无法从视频截取封面: {video_path}")




@tool()
async def bili_send_dynamic(
    text: str,
    images: list[str] | None = None,
    topic_id: int = 0,
    schedule_time: int = 0,
) -> str:
    """
    发布B站图文动态

    Args:
        text: 动态文本内容，支持@和表情（如 [doge]）
        images: 图片列表，每项可以是本地文件路径或图片URL，最多9张。为空则发布纯文字动态
        topic_id: 话题ID（可选，0表示不关联话题）
        schedule_time: 定时发布的Unix时间戳（可选，0表示立即发布）

    Returns:
        发布结果，包含动态ID
    """
    if not text or not text.strip():
        return json.dumps({"success": False, "error": "text 不能为空"}, ensure_ascii=False)

    cred = get_cred()

    dyn = dynamic.BuildDynamic.empty()
    dyn.add_plain_text(text.strip())
    # 上传图片
    if images:
        for img_path in images[:9]:
            try:
                if not img_path or not img_path.strip():
                    continue
                img_path = img_path.strip()
                if img_path.startswith(("http://", "https://")):
                    pic = await Picture.async_from_url(img_path)
                else:
                    if not os.path.isfile(img_path):
                        return json.dumps({"success": False, "error": f"图片文件不存在: {img_path}"}, ensure_ascii=False)
                    pic = Picture.from_file(img_path)
                dyn.add_image(pic)
            except Exception as e:
                return json.dumps({"success": False, "error": f"图片处理失败: {img_path} - {str(e)}"}, ensure_ascii=False)

    if topic_id:
        dyn.set_topic(topic_id)

    if schedule_time > 0:
        dyn.set_send_time(schedule_time)

    try:
        result = await dynamic.send_dynamic(info=dyn, credential=cred)
        return json.dumps({
            "success": True,
            "message": "动态发布成功",
            "data": result if isinstance(result, dict) else str(result),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ========== Tool 9: 上传视频 ==========

@tool()
async def bili_upload_video(
    video_path: str,
    title: str,
    desc: str = "",
    tid: int = 124,
    tags: str = "AI",
    cover_path: str = "",
    source: str = "",
    dynamic_text: str = "",
    no_reprint: bool = True,
) -> str:
    """
    上传视频到B站

    Args:
        video_path: 视频文件的本地路径
        title: 视频标题（最多80字）
        desc: 视频简介描述
        tid: 分区ID，默认124（趣味科普人文-社科·法律·心理）。
             常用分区：17=单机游戏 21=日常 95=数码 122=野生技术协会
             124=社科 160=生活记录 171=电子竞技 183=影视杂谈
             188=科技资讯 201=科学 207=财经商业 208=科技 209=手工
             230=其他(生活) 231=美食 234=健身 32=完结动画
        tags: 标签，逗号分隔，如"AI,教程,编程"（至少1个标签）
        cover_path: 封面图片路径（可选，不填则B站自动截取）
        source: 转载来源URL（非原创时必填）
        dynamic_text: 粉丝动态文本（可选，投稿时同步发布的动态内容）
        no_reprint: 是否启用未经作者授权禁止转载，默认True

    Returns:
        上传结果，包含BV号
    """
    # ---- 参数校验 ----
    if not video_path or not video_path.strip():
        return json.dumps({"success": False, "error": "video_path 不能为空，请提供视频文件的本地路径"}, ensure_ascii=False)

    video_path = video_path.strip()
    if not os.path.isfile(video_path):
        return json.dumps({"success": False, "error": f"视频文件不存在: {video_path}"}, ensure_ascii=False)

    if not title or not title.strip():
        return json.dumps({"success": False, "error": "title 不能为空"}, ensure_ascii=False)

    cred = get_cred()

    try:
        # 准备分P
        page = VideoUploaderPage(
            path=video_path,
            title=title.strip()[:80],
            description=(desc or "")[:250],
        )

        # 标签处理
        tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()]
        if not tag_list:
            tag_list = ["视频"]

        # 判断原创/转载
        is_original = not bool(source and source.strip())

        # 封面：用户提供 > 自动从视频截取
        if cover_path and cover_path.strip() and os.path.isfile(cover_path.strip()):
            cover_pic = Picture.from_file(cover_path.strip())
        else:
            cover_pic = _extract_cover_from_video(video_path)

        meta = VideoMeta(
            tid=tid,
            title=title.strip()[:80],
            desc=desc or "",
            cover=cover_pic,
            tags=tag_list,
            original=is_original,
            source=source.strip() if source and source.strip() else None,
            no_reprint=no_reprint if is_original else False,
            dynamic=dynamic_text.strip() if dynamic_text and dynamic_text.strip() else None,
        )

        uploader = VideoUploader(
            pages=[page],
            meta=meta,
            credential=cred,
        )

        # 上传事件回调（记录进度）
        progress_info = {"phase": "初始化"}

        @uploader.on("__ALL__")
        async def on_event(data: dict):
            progress_info["phase"] = str(data)

        result = await uploader.start()
        return json.dumps({
            "success": True,
            "message": "视频上传成功",
            "data": result if isinstance(result, dict) else str(result),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "last_phase": progress_info.get("phase", "unknown") if "progress_info" in dir() else "init",
        }, ensure_ascii=False)


# ========== Tool 10: 上传多P视频 ==========

@tool()
async def bili_upload_video_multi(
    video_paths: list[str],
    page_titles: list[str],
    title: str,
    desc: str = "",
    tid: int = 124,
    tags: str = "AI",
    cover_path: str = "",
    source: str = "",
) -> str:
    """
    上传多P视频到B站（多个分P合并为一个投稿）

    Args:
        video_paths: 视频文件路径列表，如["/path/p1.mp4", "/path/p2.mp4"]
        page_titles: 各分P标题列表，与video_paths一一对应
        title: 视频总标题
        desc: 视频简介
        tid: 分区ID，默认124
        tags: 标签，逗号分隔
        cover_path: 封面图片路径（可选）
        source: 转载来源URL（非原创时必填）

    Returns:
        上传结果
    """
    cred = get_cred()

    if not video_paths:
        return json.dumps({"success": False, "error": "video_paths 不能为空"}, ensure_ascii=False)
    if not page_titles:
        return json.dumps({"success": False, "error": "page_titles 不能为空"}, ensure_ascii=False)
    if len(video_paths) != len(page_titles):
        return json.dumps({"success": False, "error": "video_paths 和 page_titles 数量必须一致"}, ensure_ascii=False)

    try:
        pages = []
        for i, vp in enumerate(video_paths):
            vp = (vp or "").strip()
            if not vp or not os.path.isfile(vp):
                return json.dumps({"success": False, "error": f"文件不存在: {vp}"}, ensure_ascii=False)
            pages.append(VideoUploaderPage(
                path=vp,
                title=(page_titles[i] or "").strip()[:80] or f"P{i+1}",
                description="",
            ))

        tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()] or ["视频"]
        is_original = not bool(source and source.strip())

        # 封面：用户提供 > 从第一个视频自动截取
        if cover_path and cover_path.strip() and os.path.isfile(cover_path.strip()):
            cover_pic = Picture.from_file(cover_path.strip())
        else:
            cover_pic = _extract_cover_from_video(pages[0].path)

        meta = VideoMeta(
            tid=tid,
            title=(title or "").strip()[:80],
            desc=desc or "",
            cover=cover_pic,
            tags=tag_list,
            original=is_original,
            source=source.strip() if source and source.strip() else None,
        )

        uploader = VideoUploader(pages=pages, meta=meta, credential=cred)

        result = await uploader.start()
        return json.dumps({
            "success": True,
            "message": f"多P视频上传成功（共{len(pages)}P）",
            "data": result if isinstance(result, dict) else str(result),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ========== Tool 11: 发布专栏文章 (Opus) ==========

@tool()
async def bili_send_opus(
    title: str,
    content: str,
    images: list[str] | None = None,
    category_id: int = 0,
) -> str:
    """
    发布B站图文（Opus，新版专栏）

    Args:
        title: 文章标题
        content: 文章正文内容（纯文本，段落用换行分隔）
        images: 文章中插入的图片路径或URL列表（可选）
        category_id: 分类ID（可选，0表示不指定）

    Returns:
        发布结果
    """
    cred = get_cred()

    dyn = dynamic.BuildDynamic.empty()

    # 专栏动态以纯文本+图片方式构建
    # 标题作为第一行加粗
    full_text = f"【{title}】\n\n{content}"
    dyn.add_plain_text(full_text)

    if images:
        for img_path in images:
            try:
                if not img_path or not img_path.strip():
                    continue
                img_path = img_path.strip()
                if img_path.startswith(("http://", "https://")):
                    pic = await Picture.async_from_url(img_path)
                else:
                    pic = Picture.from_file(img_path)
                dyn.add_image(pic)
            except Exception as e:
                pass  # 图片失败不阻断发布

    try:
        result = await dynamic.send_dynamic(info=dyn, credential=cred)
        return json.dumps({
            "success": True,
            "message": "图文发布成功",
            "data": result if isinstance(result, dict) else str(result),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ========== Tool 12: 查询分区列表 ==========

@tool()
async def bili_video_zones() -> str:
    """
    获取B站视频常用分区ID列表，供上传视频时选择tid参数

    Returns:
        常用分区ID及名称
    """
    zones = {
        "科技": {
            188: "科技资讯", 122: "野生技术协会", 95: "数码",
            208: "科技", 209: "手工",
        },
        "知识": {
            201: "科学", 124: "社科·法律·心理", 207: "财经商业",
            228: "人文历史", 36: "科技(知识)",
        },
        "生活": {
            21: "日常", 160: "生活记录", 230: "其他",
            231: "美食", 234: "健身", 161: "搞笑",
        },
        "游戏": {
            17: "单机游戏", 171: "电子竞技", 172: "手机游戏",
            65: "网络游戏",
        },
        "影视": {
            183: "影视杂谈", 138: "搞笑", 182: "影视剪辑",
        },
        "动画": {
            32: "完结动画", 33: "连载动画", 51: "MAD·AMV",
        },
        "音乐": {
            28: "原创音乐", 31: "翻唱", 59: "演奏",
        },
    }
    return json.dumps(zones, ensure_ascii=False)


# ========================================================================
#                        V1.2 — 数据分析 & 互动运营
# ========================================================================


# ========== Tool 13: 热门视频 ==========

@tool()
async def bili_hot_videos(pn: int = 1, ps: int = 20) -> str:
    """
    获取B站当前热门视频列表

    Args:
        pn: 页码，默认1
        ps: 每页数量，默认20，最大50

    Returns:
        热门视频列表，包含标题、播放量、UP主等
    """
    result = await hot.get_hot_videos(pn=pn, ps=min(ps, 50))
    videos = []
    for item in result.get("list", []):
        stat = item.get("stat", {})
        videos.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "author": item.get("owner", {}).get("name", ""),
            "play": stat.get("view", 0),
            "like": stat.get("like", 0),
            "danmaku": stat.get("danmaku", 0),
            "reply": stat.get("reply", 0),
            "desc": (item.get("desc", "") or "")[:100],
            "duration": item.get("duration", 0),
            "tname": item.get("tname", ""),
        })
    return json.dumps({"page": pn, "count": len(videos), "videos": videos}, ensure_ascii=False)


# ========== Tool 14: 热搜关键词 ==========

@tool()
async def bili_hot_buzzwords(page_num: int = 1, page_size: int = 20) -> str:
    """
    获取B站热搜词/热门关键词

    Args:
        page_num: 页码，默认1
        page_size: 每页数量，默认20

    Returns:
        热搜词列表
    """
    result = await hot.get_hot_buzzwords(page_num=page_num, page_size=page_size)
    return json.dumps(result, ensure_ascii=False)


# ========== Tool 15: 每周必看 ==========

@tool()
async def bili_weekly_hot(week: int = 0) -> str:
    """
    获取B站每周必看视频推荐

    Args:
        week: 期数（0表示获取期数列表，>0表示获取该期的视频）

    Returns:
        每周必看期数列表或指定期的视频列表
    """
    if week <= 0:
        result = await hot.get_weekly_hot_videos_list()
        return json.dumps(result, ensure_ascii=False)
    else:
        result = await hot.get_weekly_hot_videos(week=week)
        return json.dumps(result, ensure_ascii=False)


# ========== Tool 16: 排行榜 ==========

@tool()
async def bili_rank(category: str = "all", day: int = 3) -> str:
    """
    获取B站各分区排行榜

    Args:
        category: 分区名，可选值：
            all=全站 original=原创 rookie=新人
            douga=动画 music=音乐 dance=舞蹈 game=游戏
            knowledge=知识 technology=科技 sports=运动 car=汽车
            life=生活 food=美食 animal=动物 fashion=时尚
            ent=娱乐 cinephile=影视
        day: 时间维度，3=三日 7=七日

    Returns:
        排行榜视频列表
    """
    type_map = {
        "all": rank.RankType.All, "original": rank.RankType.Original,
        "rookie": rank.RankType.Rookie, "douga": rank.RankType.Douga,
        "music": rank.RankType.Music, "dance": rank.RankType.Dance,
        "game": rank.RankType.Game, "knowledge": rank.RankType.Knowledge,
        "technology": rank.RankType.Technology, "sports": rank.RankType.Sports,
        "car": rank.RankType.Car, "life": rank.RankType.Life,
        "food": rank.RankType.Food, "animal": rank.RankType.Animal,
        "fashion": rank.RankType.Fashion, "ent": rank.RankType.Ent,
        "cinephile": rank.RankType.Cinephile,
    }
    day_map = {3: rank.RankDayType.THREE_DAY, 7: rank.RankDayType.WEEK}

    rank_type = type_map.get(category.lower(), rank.RankType.All)
    rank_day = day_map.get(day, rank.RankDayType.THREE_DAY)

    result = await rank.get_rank(type_=rank_type, day=rank_day)
    videos = []
    for item in result.get("list", []):
        stat = item.get("stat", {})
        videos.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "author": item.get("owner", {}).get("name", ""),
            "play": stat.get("view", 0),
            "like": stat.get("like", 0),
            "coin": stat.get("coin", 0),
            "score": item.get("score", 0),
            "tname": item.get("tname", ""),
        })
    return json.dumps({"category": category, "day": day, "count": len(videos), "videos": videos}, ensure_ascii=False)


# ========== Tool 17: 用户信息 ==========

@tool()
async def bili_user_info(uid: int) -> str:
    """
    获取B站用户的详细信息

    Args:
        uid: 用户UID

    Returns:
        用户昵称、粉丝数、关注数、签名、等级、视频数等
    """
    cred = get_cred()
    u = user.User(uid=uid, credential=cred)
    info = await u.get_user_info()

    # 尝试获取UP主数据
    up_stat = {}
    try:
        up_stat = await u.get_up_stat()
    except:
        pass

    relation = {}
    try:
        relation = await u.get_relation_info()
    except:
        pass

    return json.dumps({
        "uid": uid,
        "name": info.get("name", ""),
        "sign": info.get("sign", ""),
        "level": info.get("level", 0),
        "face": info.get("face", ""),
        "fans": relation.get("follower", info.get("follower", 0)),
        "following": relation.get("following", info.get("following", 0)),
        "likes": up_stat.get("likes", 0),
        "archive_view": up_stat.get("archive", {}).get("view", 0),
        "article_view": up_stat.get("article", {}).get("view", 0),
        "is_senior_member": info.get("is_senior_member", 0),
        "top_photo": info.get("top_photo", ""),
    }, ensure_ascii=False)


# ========== Tool 18: 用户视频列表 ==========

@tool()
async def bili_user_videos(uid: int, pn: int = 1, ps: int = 30, order: str = "pubdate", keyword: str = "") -> str:
    """
    获取B站用户的投稿视频列表

    Args:
        uid: 用户UID
        pn: 页码，默认1
        ps: 每页数量，默认30
        order: 排序方式 pubdate=最新 click=播放量 stow=收藏
        keyword: 搜索关键词（在该用户视频中搜索）

    Returns:
        视频列表
    """
    cred = get_cred()
    u = user.User(uid=uid, credential=cred)

    order_map = {
        "pubdate": user.VideoOrder.PUBDATE,
        "click": user.VideoOrder.VIEW,
        "stow": user.VideoOrder.FAVORITE,
    }
    order_enum = order_map.get(order, user.VideoOrder.PUBDATE)

    result = await u.get_videos(pn=pn, ps=ps, order=order_enum, keyword=keyword)
    videos = []
    for item in result.get("list", {}).get("vlist", []):
        videos.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "play": item.get("play", 0),
            "comment": item.get("comment", 0),
            "created": item.get("created", 0),
            "length": item.get("length", ""),
            "description": (item.get("description", "") or "")[:100],
        })
    return json.dumps({
        "uid": uid,
        "page": pn,
        "total": result.get("page", {}).get("count", 0),
        "count": len(videos),
        "videos": videos,
    }, ensure_ascii=False)


# ========== Tool 19: 收藏夹列表 ==========

@tool()
async def bili_favorite_lists(uid: int = 0) -> str:
    """
    获取用户的收藏夹列表

    Args:
        uid: 用户UID（0表示获取自己的收藏夹）

    Returns:
        收藏夹列表，包含ID、名称、视频数量
    """
    cred = get_cred()
    if uid == 0:
        # 从凭证获取自己的UID
        import json as _json
        with open(CRED_FILE) as f:
            data = _json.load(f)
        uid = int(data.get("dedeuserid", 0))

    result = await favorite_list.get_video_favorite_list(uid=uid, credential=cred)
    fav_lists = []
    for item in (result.get("list", []) or []):
        fav_lists.append({
            "id": item.get("id", 0),
            "title": item.get("title", ""),
            "media_count": item.get("media_count", 0),
            "fav_state": item.get("fav_state", 0),
        })
    return json.dumps({"uid": uid, "count": len(fav_lists), "lists": fav_lists}, ensure_ascii=False)


# ========== Tool 20: 收藏夹内容 ==========

@tool()
async def bili_favorite_content(media_id: int, page: int = 1, keyword: str = "") -> str:
    """
    获取收藏夹内的视频列表

    Args:
        media_id: 收藏夹ID（从 bili_favorite_lists 获取）
        page: 页码，默认1
        keyword: 搜索关键词（在收藏夹内搜索）

    Returns:
        收藏夹内的视频列表
    """
    cred = get_cred()
    result = await favorite_list.get_video_favorite_list_content(
        media_id=media_id,
        page=page,
        keyword=keyword if keyword else None,
        credential=cred,
    )
    medias = []
    for item in (result.get("medias", []) or []):
        medias.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "play": item.get("cnt_info", {}).get("play", 0),
            "collect": item.get("cnt_info", {}).get("collect", 0),
            "author": item.get("upper", {}).get("name", ""),
            "duration": item.get("duration", 0),
            "fav_time": item.get("fav_time", 0),
        })
    return json.dumps({
        "media_id": media_id,
        "page": page,
        "has_more": result.get("has_more", False),
        "count": len(medias),
        "medias": medias,
    }, ensure_ascii=False)


# ========== Tool 21: 发私信 ==========

@tool()
async def bili_send_message(receiver_uid: int, text: str) -> str:
    """
    给B站用户发送私信

    Args:
        receiver_uid: 接收者的UID
        text: 私信文本内容

    Returns:
        发送结果
    """
    cred = get_cred()

    if not text or not text.strip():
        return json.dumps({"success": False, "error": "text 不能为空"}, ensure_ascii=False)

    try:
        result = await session.send_msg(
            credential=cred,
            receiver_id=receiver_uid,
            msg_type=session.EventType.TEXT,
            content=text.strip(),
        )
        # ⭐ 校验「真的投递了」：只凭"没抛异常"就报成功是假的
        #    （上游 0.1.18 的实测：接口 code=0 但没有 msg_key ⇒ 那条私信根本没出去，
        #      调用方却显示"已发送"。见 issues #35 / #25）
        data = result if isinstance(result, dict) else {}
        msg_key = data.get("msg_key") or data.get("msg_seqno")
        if isinstance(result, dict) and not msg_key:
            return json.dumps({
                "success": False,
                "error": "接口没报错，但回执里没有 msg_key —— 这条私信大概率没真投递出去",
                "receiver_uid": receiver_uid,
                "data": data,
            }, ensure_ascii=False)
        return json.dumps({
            "success": True,
            "message": f"私信已发送给UID:{receiver_uid}",
            "msg_key": msg_key,
            "data": data if data else str(result),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ========== Tool 22: 未读消息 ==========

@tool()
async def bili_unread_messages() -> str:
    """
    获取B站未读消息数（私信、@、回复、点赞等）

    Returns:
        各类未读消息数量
    """
    cred = get_cred()
    try:
        result = await session.get_unread_messages(credential=cred)
        return json.dumps(result, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)


# ========== Tool 23: 最近收到的回复 ==========


@tool()
async def bili_triple(bvid: str, mode: str = "like", coin_num: int = 1) -> str:
    """给一个视频点赞 / 投币 / 收藏 / 一键三连。

    Args:
        bvid: 视频BV号（也接受纯数字 aid）
        mode: like=只点赞 / coin=只投币 / fav=只收藏 / like_fav=点赞+收藏 / triple=一键三连
        coin_num: 投币枚数（1 或 2，默认 1；只有 coin / triple 用到）

    Returns:
        JSON：做了什么、以及视频标题
    """
    cred = get_cred()
    bvid = str(bvid or "").strip()
    if bvid.isdigit():
        try:
            from bilibili_api.utils.aid_bvid_transformer import aid2bvid
            bvid = str(aid2bvid(int(bvid)))
        except Exception:
            pass
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    title = str(info.get("title") or "")
    mode = str(mode or "like").strip().lower()
    做了 = []
    跳过 = []

    async def 点赞():
        if await v.has_liked():
            跳过.append("点赞（之前点过）")
            return
        await v.like(1)
        做了.append("点赞")

    async def 投币():
        n = max(1, min(2, int(coin_num or 1)))
        await v.pay_coin(n, False)
        做了.append("投币 " + str(n) + " 枚")

    async def 收藏():
        if await v.has_favoured():
            跳过.append("收藏（之前收过）")
            return
        from bilibili_api import favorite_list
        mid = int(getattr(cred, "dedeuserid", 0) or 0)
        fav_id = 0
        try:
            # ⚠️ 2026-10-22 修：这个版本里没有 get_favorite_list，正确名字是 get_video_favorite_list
            data = await favorite_list.get_video_favorite_list(uid=mid, credential=cred)
            for it in (data.get("list") or []):
                if it.get("id"):
                    fav_id = int(it["id"])
                    break
        except Exception as e:
            raise RuntimeError("拿不到默认收藏夹：" + str(e))
        if not fav_id:
            raise RuntimeError("账号里没有可用的收藏夹")
        await v.set_favorite(add_media_ids=[fav_id], del_media_ids=[])
        做了.append("收藏（收藏夹 " + str(fav_id) + "）")

    try:
        if mode == "triple":
            # ⚠️ 2026-10-22：库里的 triple() 一步失败就整条崩（实测 -403 全灭）。
            #    改成一步一步来，失败只记哪一步失败，成功的照样算。
            # ⚠️ 2026-10-22 按使用者要求：**不投币**（B站 对小号投币报 -401，且会花硬币）。
            #    一键三连 = 点赞 + 收藏。
            for 步 in (点赞, 收藏):
                try:
                    await 步()
                except Exception as e:
                    跳过.append(步.__name__ + "失败：" + str(e)[:60])
        elif mode == "like":
            await 点赞()
        elif mode == "coin":
            await 投币()
        elif mode == "fav":
            await 收藏()
        elif mode == "like_fav":
            await 点赞()
            await 收藏()
        else:
            return json.dumps({"ok": False, "error": "不认识的 mode：" + mode}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "bvid": bvid, "title": title,
                           "做了": 做了, "error": str(e)}, ensure_ascii=False)

    # ⭐ 0.9.9：三连过 = 已经刷到人眼前了，记进判重表（免得下一轮又推一遍）
    _seen_note_video(bvid)

    return json.dumps({"ok": True, "bvid": bvid, "title": title, "mode": mode,
                       "做了": 做了, "跳过": 跳过}, ensure_ascii=False)



def _dm_get(url: str):
    """私信接口在老的 vc 域名上，不属于 bilibili_api 的封装 —— 用标准库 urllib 带凭证 cookie 取。
    ⚠️ 这个 venv 里没有 requests（实测 ModuleNotFoundError），所以别引入新依赖。"""
    import urllib.request
    cred = get_cred()
    cookies = cred.get_cookies() or {}
    cookie = "; ".join(str(k) + "=" + str(v) for k, v in cookies.items())
    req = urllib.request.Request(url, headers={
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "referer": "https://message.bilibili.com/",
        "cookie": cookie,
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))


@tool()
async def bili_dm_recent(size: int = 20, talker_id: int = 0, pages: int = 1) -> str:
    """读最近收到的私信（**不做身份过滤**，谁发的都原样返回，由宿主按名单筛）。

    Args:
        size: 每页读多少条（1~30，默认 20）
        talker_id: 读哪个会话（0 = 发给自己那条）。⚠️ 别人转发给你的，要填**对方的 uid**
        pages: 往前翻几页（1~5，默认 1）。
            ⚠️ 为什么需要它：**你自己回得多**，最近 20 条可能全是你自己发的，
               对方那条转发就被挤出窗口了 —— 宿主看到的永远是空的。

    Returns:
        JSON：{ok, me, talker, count, items:[{key, ts, from_uid, bv, text, is_card}]}
        ⚠️ 分享卡片（msg_type=7/8）在 B站 的 content 里**没有 content 字段**，
           只有 bvid / jump_url / title / author —— 不特殊处理就会被当成空消息丢掉。
    """
    cred = get_cred()
    me = int(getattr(cred, "dedeuserid", 0) or 0)
    n = max(1, min(30, int(size or 20)))
    if int(talker_id or 0):
        talker = int(talker_id)
    else:
        talker = me
        try:
            d0 = _dm_get("https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions"
                         "?session_type=1&group_id=0&build=0&mobi_app=web")
            for it in ((d0.get("data") or {}).get("session_list") or []):
                tid = int((it.get("talker_id") or 0))
                if tid and tid == me:
                    talker = tid
                    break
        except Exception:
            pass
    base = ("https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs"
            "?talker_id=" + str(talker) + "&session_type=1&size=" + str(n) + "&build=0&mobi_app=web")
    import re as _re
    页数 = max(1, min(5, int(pages or 1)))
    raw = []
    end_seqno = None
    for _ in range(页数):
        url = base + (("&end_seqno=" + str(end_seqno)) if end_seqno else "")
        d = _dm_get(url)
        batch = ((d.get("data") or {}).get("messages") or [])
        if not batch:
            break
        raw.extend(batch)
        try:
            end_seqno = min(int(m.get("msg_seqno") or 0) for m in batch)
        except Exception:
            break
        if not end_seqno:
            break
    # 去重 + 按时间从旧到新（翻页会带回重复的边界消息）
    seen_key = set()
    msgs = []
    for m in raw:
        k = str(m.get("msg_key") or m.get("msg_seqno") or m.get("timestamp"))
        if k in seen_key:
            continue
        seen_key.add(k)
        msgs.append(m)
    msgs.sort(key=lambda x: int(x.get("timestamp") or 0))
    out = []
    for m in msgs:
        mt = int(m.get("msg_type") or 1)
        try:
            c = json.loads(m.get("content") or "{}")
        except Exception:
            c = {}
        if not isinstance(c, dict):
            c = {}   # msg_type=5 的 content 是纯数字，json.loads 出来是 int
        bv = ""
        is_card = False
        if mt in (7, 8) and (c.get("jump_url") or c.get("bvid") or c.get("author") or c.get("title")):
            is_card = True
            bv = str(c.get("bvid") or "")
            if not bv:
                mm = _re.search(r"BV[0-9A-Za-z]{10}", str(c.get("jump_url") or ""))
                bv = mm.group(0) if mm else ""
            text = "[分享视频] " + str(c.get("title") or c.get("headline") or "")[:80] \
                   + ((" / " + str(c.get("author"))) if c.get("author") else "") \
                   + ((" " + bv) if bv else "")
        else:
            text = str(c.get("content") or c.get("text") or "")
            if not bv:
                mm = _re.search(r"BV[0-9A-Za-z]{10}", text)
                bv = mm.group(0) if mm else ""
        if not text and not bv:
            continue
        out.append({
            "key": str(m.get("msg_key") or m.get("msg_seqno") or m.get("timestamp")),
            "ts": int(m.get("timestamp") or 0),
            "from_uid": int(m.get("sender_uid") or 0),
            "bv": bv,
            "text": text[:300],
            "is_card": is_card,
        })
    return json.dumps({"ok": True, "me": me, "talker": talker, "count": len(out), "items": out},
                      ensure_ascii=False)


def _nick_of(it) -> str:
    """会话项里能顺手拿到昵称就拿到（拿不到就空字符串，宿主会退回显示 UID）。"""
    lm = it.get("last_msg") or {}
    for ai in (lm.get("account_info"), it.get("account_info")):
        if isinstance(ai, dict) and ai.get("name"):
            return str(ai["name"])
    return ""


@tool()
async def bili_dm_sessions(size: int = 10) -> str:
    """看私信会话列表：谁给你发过、几个还没读。

    宿主用它先找「谁有新私信」，再按 talker_id 去 `bili_dm_recent` 读内容 ——
    比每次把所有会话的内容全拉一遍便宜得多。

    Args:
        size: 看前几个会话（1~20，默认 10）

    Returns:
        JSON：{ok, me, count, items:[{talker_uid, nick, unread, ts, last_from, last_text, is_card}]}
    """
    cred = get_cred()
    me = int(getattr(cred, "dedeuserid", 0) or 0)
    n = max(1, min(20, int(size or 10)))
    try:
        d = await session.get_sessions(cred, session_type=1)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)
    lst = (d or {}).get("session_list") or []
    items = []
    for it in lst[:n]:
        try:
            uid = int(it.get("talker_id") or 0)
        except Exception:
            continue
        if not uid or uid == me:
            continue          # 自己跟自己那条（转发用）不算「有人找你」
        lm = it.get("last_msg") or {}
        mt = int(lm.get("msg_type") or 1)
        try:
            c = json.loads(lm.get("content") or "{}")
        except Exception:
            c = {}
        if not isinstance(c, dict):
            c = {}   # msg_type=5 的 content 是纯数字，json.loads 出来是 int
        is_card = mt in (7, 8)
        text = "[分享视频] " + str(c.get("title") or c.get("headline") or "")[:80] if is_card \
            else str(c.get("content") or c.get("text") or "")
        nick = _nick_of(it)
        if not nick:
            try:
                u = await user.get_user_info(uid)
                nick = str((u or {}).get("name") or "")
            except Exception:
                nick = ""
        items.append({
            "talker_uid": uid,
            "nick": nick,
            "unread": int(it.get("unread_count") or 0),
            "ts": int(lm.get("timestamp") or it.get("session_ts") or 0),
            "last_from": int(lm.get("sender_uid") or 0),
            "last_text": text[:150],
            "is_card": is_card,
        })
    return json.dumps({"ok": True, "me": me, "count": len(items), "items": items},
                      ensure_ascii=False)


@tool()
async def bili_received_replies() -> str:
    """
    获取最近收到的评论回复通知

    Returns:
        回复列表
    """
    cred = get_cred()
    try:
        raw = await session.get_replies(credential=cred)
        return json.dumps({"items": _norm_feed("reply", raw)}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)


# ========== Tool 24: 最近收到的@和点赞 ==========

@tool()
async def bili_received_at_and_likes() -> str:
    """
    获取最近收到的@提及和点赞通知

    Returns:
        包含 at 和 likes 两部分的通知数据
    """
    cred = get_cred()
    result = {}
    try:
        result["items"] = _norm_feed("at", await session.get_at(credential=cred))
    except Exception as e:
        result["at_error"] = str(e)
    try:
        result["likes"] = await session.get_likes(credential=cred)
    except Exception as e:
        result["likes_error"] = str(e)
    return json.dumps(result, ensure_ascii=False)


# ========== 收到的 @ / 回复：整理成统一形状 ==========
#
# 原始 msgfeed 长这样（字段名很不直观）：
#   {"items":[{"id":..,"user":{"mid":..,"nickname":..},
#              "item":{"business_id":1,"subject_id":<aid>,"source_id":<评论id>,
#                      "root_id":<根评论>,"target_reply_id":..,"title":"..","source_content":".."},
#              "at_time" 或 "reply_time": ..}]}
# 宿主只需要能看懂的几样：谁、在哪个视频、说了什么、要回哪一条。
# business_id：1 视频 / 11 / 12 专栏 / 17 动态 —— 这里只处理 1（视频）。

def _bvid_of(aid):
    """aid 转 bvid；转不了返回空串（不抛异常，别把整条消息搞没）"""
    try:
        if not aid:
            return ""
        from bilibili_api.utils.aid_bvid_transformer import aid2bvid
        return str(aid2bvid(int(aid)))
    except Exception:
        return ""


def _norm_feed(kind, raw):
    out = []
    items = raw.get("items") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        return out
    for it in items:
        try:
            user = it.get("user") or {}
            inner = it.get("item") or {}
            bid = int(inner.get("business_id") or 0)
            subject = inner.get("subject_id") or 0
            out.append({
                "kind": kind,
                "id": it.get("id"),
                "mid": user.get("mid"),
                "nickname": (user.get("nickname") or "").strip(),
                "business_id": bid,
                "bvid": _bvid_of(subject) if bid == 1 else "",
                "aid": subject if bid == 1 else 0,
                "title": (inner.get("title") or "").strip(),
                "content": (inner.get("source_content") or "").strip(),
                # 要回哪一条：source_id = 对方发的那条（parent），root_id = 楼层根（root）
                "rpid": inner.get("source_id") or 0,
                "root": inner.get("root_id") or 0,
                "at": it.get("at_time") or it.get("reply_time") or 0,
            })
        except Exception:
            continue
    return out


# ========== 启动 ==========

if __name__ == "__main__":
    mcp.run(transport="stdio")
