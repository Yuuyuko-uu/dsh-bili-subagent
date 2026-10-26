# Platform runtime regression

Run `npm run test:platform` with Node 22 or newer. No package installation is needed.
The tests use temporary synthetic files, fake downloads/extraction and simulated
subprocess results. They never download uv or contact Bilibili.

Asset names follow the [official uv 0.13.5 release table](https://github.com/astral-sh/uv/releases/tag/0.13.5):
Windows x64/ARM64/x86, macOS Intel/ARM64, and Linux x64/ARM64/x86 (GNU libc).
Other combinations fail automatic-download selection explicitly. This change does
not add musl detection, ARMv7 downloads, Python dependency qualification or real
DSH/Bilibili acceptance.

The workflow runs Node 22 on Windows x64, Ubuntu x64/ARM64 and macOS Intel/ARM64,
plus Node 24 on Ubuntu x64. Runner labels follow the
[GitHub runner table](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

A separate CI integration step runs `node scripts/verify-uv-release.mjs`. It downloads
the selected official **0.13.5** release asset and its official SHA-256 sidecar, fails
closed on missing/mismatching checksums, extracts into a unique temporary directory,
and executes `uv --version`. This step requires GitHub network access and validates
the actual runner binary; it does not install Python or qualify DSH/Bilibili behavior.
The unit tests above remain fully synthetic and offline.
