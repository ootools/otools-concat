# v0.1.0 发布验证

验证日期：2026-11-25；平台：macOS arm64。

## 结果

- `npm test`：25/25 通过，包含八语种键集合、顺序、非空文本和占位符一致性检查。
- `npm run test:src`：18/18 通过，覆盖时间线操作、渲染计划与 QOI 编解码。
- `npm run build`：TypeScript / Vue 类型检查与 Vite 构建通过。Vite 提示 dialog shim 同时静态与动态引入，不影响产物。
- `cargo test --locked --manifest-path service/Cargo.toml`：编译通过；Rust 当前没有单元测试，服务行为由下述冒烟检查覆盖。
- `cargo build --locked --release --manifest-path service/Cargo.toml`：通过；产物与 `bin/concatd-macos` 字节相同。
- `npm run smoke`：sidecar 握手、两段视频探针、缩略图、QOI 覆盖层上传、滤镜拼接渲染及输出检查通过；成片 2.00 秒，H.264 视频 + AAC 音频。
- `node scripts/verify-media-runtime.mjs`：运行时源码锁、归档 SHA256、许可、arm64 Mach-O、最低 macOS 12、签名和仅系统动态库校验通过；复制到隔离目录、限制 PATH 后的媒体操作通过。
- `node scripts/pack-plugin.mjs --platforms macos` 和 `node scripts/verify-plugin.mjs`：正式单合包生成并通过校验（ZIP CRC、manifest、哈希、宿主桥、sidecar、FFmpeg 与平台支持标志）。

## 多语言补齐

原生导入、打开工程、保存工程、导出对话框的标题和文件分类改为读取当前翻译字典。中文、英文、日文、韩文、德文、俄文、西班牙文、阿拉伯文均已补齐，宿主切换语言后再次打开对话框会读取新语言。媒体服务能力缺失提示也复用翻译文案。

语言资源校验和类型检查不能替代八种语言的逐界面人工审校。本轮未进行宿主 GUI 安装及逐语种视觉验收。

## 版本范围

v0.1.0 仅提供 macOS Apple Silicon 资产，单合包 `packageMode=0`，市场标志为 `supportMacos=true`、`supportWindows=false`、`supportLinux=false`。尚未验证或提供 Intel Mac、Windows、Linux 产物。

实现范围与后续转场、关键帧及自动字幕计划见 `SPEC.md` 和 `../UPSTREAM.md`。
