# Concat Windows/Linux implementation plan

Goal: release v0.1.1 with Windows x64, Linux x64 and existing macOS arm64 support, independently downloadable packages and eight-language UI.

Architecture: retain Rust/axum service and Vue UI; build the locked FFmpeg/x264 sources for Linux and Windows (MinGW cross compiler), verify on native GitHub runners, then package and publish. macOS retains its existing source build. Source archives, exact configure options, licenses and binary hashes accompany every runtime.

Constraints: work on main; keep v0.1.0 tag immutable; no host source dependencies; do not advertise absent architecture packages. Linux build baseline Ubuntu 22.04/glibc 2.35; Windows x64 Windows 10+; macOS arm64 macOS 12+. Windows ARM, Linux ARM and Intel Mac are outside this correction's initial release matrix.

- [x] Add regression tests for subset platform URLs, independent per-platform package names, rejecting unverified runtimes before writing ZIPs, platform binary paths and dependency inspection.
- [x] Build locked sources for Linux/Windows; inspect ELF/PE and allow only OS libraries; relocate and execute encode/decode/probe checks on native runners before setting distributable status.
- [x] Fix packer to await runtime validation and produce one named platform package per target. Smoke test uses package-local platform binaries, Unicode/space paths and waits for service shutdown before cleanup.
- [x] CI builds three targets, runs source/script tests and native media/service smoke checks, then verifies artifacts before uploading release and marketplace metadata. Bump all versions to 0.1.1.
- [x] Run CI, diagnose failures, publish only once three platforms pass; verify public catalog, downloads and checksums. Document actual validation and limitations.

Review focus: Windows executable suffix and process lifetime; unverified runtime rejection; missing-architecture URLs; native dynamic dependencies; Windows Unicode/space paths and output overwrite.

## Execution notes

- Native Windows/Linux runtime compilation and three-platform CI are implemented; the final run 45568511354 passed all three platforms and native installed-archive smoke tests.
- Regression coverage: missing platform URLs, platform filenames, rejecting invalid runtime before creating archives, OS dependency classification, Windows make .exe targets.
- First Windows CI found incorrect make targets; fixed with a failing regression test followed by a passing test.
- Independent review found two important issues: installed Unix media tools lacked executable permissions, and AVICAP32.dll was incorrectly rejected as external. Both were reproduced, fixed and tested. Unix repair is limited to package-owned regular files and refuses symlinks.
- Added installed-package smoke to reproduce host extraction (0644 resources; only sidecar executable), then run service probe, project overwrite/open, thumbnail and QOI/filter/audio rendering from the extracted directory. Local macOS passed.
- Decision: keep Windows/Linux initial architecture coverage at x64; absent ARM/Intel URLs are explicitly empty. Existing v0.1.0 remains immutable; v0.1.1 replaces it through a normal update.

- Published plugin-otools-concat-v0.1.1 from verified commit 38b4abd; all three public downloads match CI bytes. Public market readback confirms version/platform URLs and cleared old combined fallback. Final publication regression suite: 34/34.
