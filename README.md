# Concat · OTools 插件

本地优先的快剪视频编辑器：多轨时间线、剪切拼接、变速、音量、滤镜与文字，离线导出 MP4。
灵感来自 [jub0t/concat](https://github.com/jub0t/concat)（CapCut 替代品）；因上游是原生
Rust 应用（Slint + 原生 FFmpeg + 本地 AI），本插件是**重新实现**而非代码移植——移植决策
与分期路线见 [`UPSTREAM.md`](UPSTREAM.md)，规格见 [`docs/SPEC.md`](docs/SPEC.md)。

## 安装

已上架 OTools 插件市场，搜索 **Concat** 或 **Concat 剪辑** 安装。
也可在 [最新 Release](https://github.com/ootools/otools-concat/releases/latest)
下载 `.oplg`，通过 OTools 本地安装。

v0.1.1 平台矩阵：**Windows x64（Windows 10+）、Linux x64（glibc 2.35+，如 Ubuntu 22.04+）、macOS Apple Silicon（arm64，macOS 12+）**，需 OTools 0.9.8+。
每个平台包内含对应的媒体服务和 FFmpeg，无需额外安装。Intel Mac、Windows ARM、Linux ARM 尚无对应产物。验证范围见 [`docs/VERIFICATION.md`](docs/VERIFICATION.md)。

## 功能（v0.1）

- **导入**：文件对话框 / 拖拽 / 以关联文件打开（视频、音频、jpg 图片）
- **媒体库**：缩略图网格、时长/分辨率、一键上时间线
- **时间线**：视频主轨 + 音频轨 + 文字轨；拖动 / 修剪 / 分割 / 删除 / 吸附 / 缩放 / 播放头
- **片段属性**：变速（0.25×–4×，音频自动 atempo 补偿）、音量、静音、eq 滤镜（亮度/对比度/
  饱和度 + 暖阳/冷调/鲜艳/黑白/褪色预设，CSS 实时预览 = ffmpeg eq 同参数）
- **文字**：多行、字体/颜色/描边/位置/对齐/加粗/斜体，canvas 全画幅渲染（QOI）+ overlay 导出
- **导出**：H.264/AAC MP4（CRF 20/23/28），进度条 + 取消；4 档分辨率（1080p/720p/竖屏/方图）
- **工程**：`.concatproj` 保存/打开（引用绝对路径，打开时自动重探针）
- **撤销/重做**：快照式 100 步；快捷键：Space 播放、S 分割、Delete 删除、⌘Z/⌘Y
- **多语言**：宿主标准 8 语种（zh-CN / en-US / ja-JP / ko-KR / de-DE / ru-RU / es-ES / ar-SA），
  跟随宿主语言切换，ar-SA 自动 RTL（时间线恒定 LTR）

## 架构

```
webview (Vue 3 + vite, dist/)
  └─ otools-plugin-sdk sidecar API
       └─ concatd (Rust/axum, service/)
            ├─ stdio 握手（token+origin，同 uniplayer 协议）
            ├─ loopback HTTP + Bearer（Range 流式 / SSE 进度）
            └─ spawn resources/ffmpeg/<platform>/{ffmpeg,ffprobe}
```

文件流转：宿主对话框拿**路径** → concatd 原生进程直接读盘 → 预览（remux/proxy 缓存）与
导出（filter_complex 渲染）全部离线完成。

## 开发

```bash
npm install
npm run dev          # http://127.0.0.1:6578（宿主 quickDev 直连）
npm run typecheck    # vue-tsc
npm test             # scripts 测试（pack/verify/publish/i18n parity）
npm run test:src     # render-plan / project / qoi 单测（node strip-types）

# sidecar
cargo check --manifest-path service/Cargo.toml
cargo build --release --manifest-path service/Cargo.toml
cp service/target/release/concatd bin/concatd-macos

# 媒体运行时（macOS arm64；或复用 otools-uniplayer 的已验证产物）
node scripts/build-media-runtime.mjs

# 端到端冒烟（无需宿主：握手→probe→缩略图→QOI→渲染→校验）
node scripts/smoke-concatd.mjs

# 打包与校验
npm run build && node scripts/pack-plugin.mjs --platforms macos
node scripts/verify-plugin.mjs dist-pack
```

开发期 concatd 用 `FFMPEG_PATH` / `FFPROBE_PATH` 环境变量指到任意 ffmpeg/ffprobe
（缺省按 `bin/../resources/ffmpeg/<platform>/` 解析）。

## 发布

推 `v<版本>` 标签触发 `.github/workflows/release-plugin.yml`：从锁定源码构建三平台运行时，在各自原生 runner 验证媒体服务后打包，再发布 Release 和市场。
手动运行不填 release_tag 时仅构建验证；补发填写已存在的标签并开启 publish_market。平台包使用 `packageMode=1`，仅发布实际构建成功的平台 URL。

## 许可

GPL-3.0-or-later（随包分发 GPL 构建的 FFmpeg + x264；源码与许可证据在
`resources/ffmpeg/<platform>/`）。上游 jub0t/concat 为 AGPL-3.0-or-later——本插件未复制其
任何代码与文案，见 [`UPSTREAM.md`](UPSTREAM.md) 与 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
