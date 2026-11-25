# Concat 媒体运行时

FFmpeg/ffprobe 与 x264 从 `runtime-source-lock.json` 锁定的源码构建，内部媒体库和 x264 静态链接，关闭外部库自动检测及网络协议。用户无需安装 Homebrew、FFmpeg、MSYS2 或 codec 动态库。

## 平台与构建

| 平台包后缀 | 架构 | 构建与原生验证 | 基线 |
| --- | --- | --- | --- |
| macos | arm64 | macOS 15 runner，Apple clang | macOS 12 部署目标 |
| windows | x64 | Ubuntu 22.04 / MinGW-w64 构建，Windows 2022 runner 验证 | Windows 10+ |
| linux | x64 | Ubuntu 22.04 GCC 构建与验证 | glibc 2.35+ |

最低系统版本为编译/依赖基线，未在所有最低版本桌面实机上人工验收。macOS Intel、Windows ARM、Linux ARM 暂无资产。

```sh
# macOS arm64
node scripts/build-media-runtime.mjs --jobs 4
node scripts/verify-media-runtime.mjs

# Linux x64 构建机：build-essential pkg-config nasm yasm
node scripts/portable-runtime.mjs build linux
node scripts/portable-runtime.mjs certify linux

# Linux x64 构建机额外安装 gcc-mingw-w64-x86-64 / g++-mingw-w64-x86-64
node scripts/portable-runtime.mjs build windows
# 将 resources/ffmpeg/windows 原样拷到 Windows x64 后执行
node scripts/portable-runtime.mjs certify windows
```

Windows 使用静态 GCC/MinGW 运行库，仅允许系统 DLL；Linux 仅允许 glibc 和系统基础库。macOS 检查系统 dylib、签名和部署版本。Windows/Linux 构建产物初始标记为未验证，只有在目标操作系统上复制到隔离目录、限制 PATH，完成 H.264/AAC 编码、探针与解码后才设置 `selfContained` / `redistributable`。随后运行 `npm run smoke` 验证真实 concatd 导出流程（含中文/空格路径、重复工程保存）。

## 锁定源码与对应源码

| 项目 | 版本 / commit | 归档 SHA256 |
| --- | --- | --- |
| FFmpeg | 9.0.2 / `946fcce07b6dcd0331c8cc609192aeff5e1924f8` | `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e` |
| x264 | r3222 / `b35605ace3ddf7c1a5d67a2eb553f034aef41d55` | `6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224` |

每个平台的 `resources/ffmpeg/<suffix>/` 包含 ffmpeg/ffprobe（Windows 为 `.exe`）、`runtime.json`、`licenses/` 和 `sources/`。源码目录提供完整原始归档、源码锁、构建脚本、configure 参数（runtime.json 内）以及 config.h / config.mak。源码没有补丁。FFmpeg 采用 `--enable-gpl --enable-version3 --enable-libx264`，分发许可 GPL-3.0-or-later；x264 源码许可 GPL-2.0-or-later，未启用 nonfree。插件和服务源码在 Release 标签对应仓库提交中提供。

`runtime.json.sha256` 记录资源摘要；正式打包等待运行时元数据和摘要验证完成，校验失败不写出 `.oplg`。打包后再次检查 ZIP CRC、manifest 与完整文件哈希。

## 媒体能力边界

导出使用软件 libx264 / AAC，图片与文字覆盖层使用 JPEG/QOI。构建没有 zlib，暂不支持 PNG 导入。没有附带 dav1d/aom，因此不承诺 AV1 软件解码。FFmpeg 编译清单包含的其他格式，不代表每个 profile 都经过实测。真实验证范围以 `VERIFICATION.md` 和 CI 运行记录为准。

v0.1.0 的运行时脚本来源于 uniplayer；播放器的字幕、HLS、HDR 服务测试不属于 Concat 的测试结果。Concat 自身的服务验证由 `scripts/smoke-concatd.mjs` 执行。
