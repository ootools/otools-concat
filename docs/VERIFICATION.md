# v0.1.1 三平台发布验证

日期：2026-11-25。发行提交 `38b4abd7d69ec2590e0cf61a97d48eb29a9d8543`，标签 `plugin-otools-concat-v0.1.1`。

[全绿 CI](https://github.com/ootools/otools-concat/actions/runs/45568511354) · [Release](https://github.com/ootools/otools-concat/releases/tag/plugin-otools-concat-v0.1.1)

| 平台 | 原生验证环境 | 结果 |
| --- | --- | --- |
| Windows x64 | windows-2022 | 运行时隔离目录运行、原始服务冒烟、解压正式包冒烟通过 |
| Linux x64 | ubuntu-22.04 | 同上，通过 |
| macOS arm64 | macos-15 | 运行时签名/系统依赖/源码哈希验证、原始服务与解压包冒烟通过；CI 包另下载到本机复验 |

每个平台 CI 均通过 33 项脚本测试、18 项核心逻辑测试、类型检查与前端构建；Unix 另通过 2 项 Rust 权限恢复测试。发布回读发现旧合包 URL 残留，发布脚本新增明确清空逻辑与回归测试后，脚本测试为 34/34；该修改仅影响市场元数据，不修改已发布二进制或标签。

真实服务冒烟覆盖：stdio 握手、中文/空格路径、工程保存/覆盖/读取、两个带音轨视频的探针、缩略图、QOI 覆盖层、滤镜拼接渲染、输出编码和时长。每个平台的解压包均导出 2.00 秒 H.264/AAC MP4。解压模拟宿主：资源文件为 0644，仅 sidecar 预先有执行权限，由 sidecar 修复包内媒体工具权限。

关键修复：MinGW make 使用 .exe 目标；Windows 系统 DLL 检查识别 AVICAP32/PSAPI；打包等待运行时校验；每个平台独立包；不填写不存在的架构 URL；清空旧版单合包回退地址。

## 公开分发校验

三个包均从公开 Release URL 完整下载并逐字节比较 CI 原件；ZIP CRC、包内 manifest、运行时所有已记录文件 SHA256、PE/ELF/Mach-O 架构及平台隔离检查通过。GitHub 资产摘要与本地相同。

- `macos`：36,819,094 字节；SHA256 `a651f0bf1249f68385cfa4bf520872a04ef9a0557ac23fc15d42ae0596da47ef`。
- `windows`：37,633,363 字节；SHA256 `1492a23aa136e6b71ec49ac6bcc6101250a1ba7e6a40e1d67356b0f8173f4a95`。
- `linux`：36,969,037 字节；SHA256 `22e04ccab8cbcd870e3f41e7197e992c0725b988dcdcc7bdcaeb7343e7c2b7ef`。

市场发布接口返回 `code=200` / `插件更新成功`。公开列表回读为 `0.1.1`、`packageMode=1`，三个操作系统支持标志均为 1，三个 URL 指向本次 Release，`packageUrl` 及未发布架构 URL 为空。

## 限制

本次验证是原生 CI 的服务/媒体/解压包流程，没有在 Windows/Linux/macOS 宿主 GUI 上逐界面人工验收。Windows 10+、Linux glibc 2.35+、macOS 12+ 是目标兼容基线，未在每个最低版本系统实机逐一验收。Intel Mac、Windows ARM、Linux ARM 不在此次发布矩阵。八语种键和占位符检查通过，但不替代逐语种视觉审校。

---

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

## 发布记录

- 发行提交：`1dca521f3b4663a6cf768ecbfad23837d5fec42c`。
- 标签：`plugin-otools-concat-v0.1.0`，与发行提交一致。
- [GitHub Release](https://github.com/ootools/otools-concat/releases/tag/plugin-otools-concat-v0.1.0)：公开正式版本（非草稿、非预发布），附 `.oplg`、`SHA256SUMS`、manifest 和 logo。
- `.oplg` 大小：37,092,174 字节；SHA256：`5906da8da12b69d3b533bf7cb51e0712ce6dd68dbe1a61371b1ad4ca5a296310`，与 GitHub 资产摘要相同。
- 已经公开下载 URL 完整下载 `.oplg` 并逐字节比对本地产物，SHA256 相同；图标 URL 内容也与仓库一致。本机 GitHub 直连不稳定，下载核验使用系统已配置的 HTTP 代理。
- 市场发布接口返回 `code=200` / `插件创建成功`；公开 `/api/v1/otools/plugin/lists` 回读确认 `otools-concat` / `0.1.0` / `packageMode=0` 和平台标志正确。
- 后续发布所需 `release` environment、`XYCLOUD_PAT` secret 与 `OTOOLS_PUBLISH_MARKET=true` 已配置。

# v0.1.1 安装后 WebView 导入回归（2026-11-26）

用户在已安装的 v0.1.1 中点击导入时，前端把 `Window.fetch` 作为对象方法保存，macOS WKWebView 因 receiver 不再是 `Window` 而拒绝调用，错误最终显示为“媒体服务不可用”。连接失败时原实现还会保留不可用客户端。

本地修复：

- `ConcatdClient` 默认 transport 改为 `globalThis.fetch.bind(globalThis)`，保留 WebKit 所需的 receiver。
- 连接只在健康检查成功后发布；健康检查失败会释放 sidecar，并清空前端客户端引用。
- 错误状态提供多语言 Retry 操作；媒体服务错误统一使用现有八语种文案。
- MediaLibrary、Timeline、PreviewPlayer 的图片/视频/音频元素显式启用 anonymous CORS，确保 loopback 媒体 URL 带 Origin 头。

验证：

- `npm test`：42/42 通过（含 WebKit receiver、失败清理、媒体元素 CORS 和八语种一致性回归）。
- `npm run test:src`：18/18 通过。
- `npm run build`：类型检查和 Vite 构建通过。
- `npm run smoke`：concatd 握手、工程读写、探针、缩略图、QOI 文字覆盖层和 H.264/AAC 导出通过。
- `npm run smoke:webview`：原生 macOS WKWebView 中完成健康检查、视频探针和中文/空格工程读写；验证 origin 为 `otools-plugin://localhost`。

该修复尚未自动创建新 Release 或更新市场版本；发布前仍需按插件仓的正常流程重新打包并进行三平台原生验证。
