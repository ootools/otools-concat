# 第三方声明

本插件随 `dist/` 分发的产物包含以下第三方代码：

## Vue

- 项目：https://github.com/vuejs/core
- 版本：3.5.x
- 许可证：MIT
- 用途：插件前端框架（运行时打包进 `dist/assets/*.js`）

## otools-plugin-sdk

- 来源：npm 发布版 `otools-plugin-sdk` ^0.4.0（https://github.com/ootools/otools-plugin-sdk）
- 许可证：Apache-2.0
- 用途：宿主桥接（runtime invoke/listen、sidecar spawn 生命周期、dialog 打开/保存）

## FFmpeg / x264（媒体运行时）

- FFmpeg 9.0.2 + x264 r3222，按源码锁（`runtime-source-lock.json`）从官方源码构建，
  静态链接，GPL-3.0-or-later 分发。源码归档、许可文件、构建/校验证据随包附带
  （`resources/ffmpeg/<platform>/sources/` 与 `licenses/`），详见 `docs/MEDIA_RUNTIME.md`。
- FFmpeg：https://ffmpeg.org （GPL-3.0-or-later 构建配置）
- x264：https://www.videolan.org/developers/x264.html （GPL-2.0-or-later）

## jub0t/concat（上游灵感来源）

- 项目：https://github.com/jub0t/concat （AGPL-3.0-or-later）
- 本插件**未复制**上游任何源码、文案或本地化文件（其 locale 文件为 AGPL，复制字符串
  会使本项目传染 AGPL）；仅在产品形态（本地优先、CapCut 式快剪）上受其启发。
- 致谢与移植记录见 `UPSTREAM.md`。

## 其他

- 图标 `logo.svg` 为本仓库原创作品。
- Rust 依赖（axum/tokio/sha2/base64 等）为 crates.io 开源 crate，许可见 `service/Cargo.toml`
  与 cargo 生成的对应声明，均为 Apache-2.0 / MIT 双许可系列。
