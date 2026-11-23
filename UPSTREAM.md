# UPSTREAM · jub0t/concat 移植记录

## 上游是什么

[jub0t/concat](https://github.com/jub0t/concat)（2026-08 发布，19.6k★，v0.2.12）：
开源、本地优先、无水印的 CapCut 替代品。**原生 Rust 桌面/移动应用**——Slint GUI（Skia/wgpu
渲染）+ 动态链接系统 FFmpeg 7（`ffmpeg-the-third`）+ 本地 AI（whisper.cpp 自动字幕、RVM 抠像、
TTS），AGPL-3.0-or-later，商标保留。全功能清单：多轨时间线、关键帧曲线、变速曲线/Beats 节拍
吸附、100+ 效果/转场、语音隔离、增强/稳定、H.264/HEVC/AV1 硬件编码导出、JSON-RPC/MCP 自动化。

## 为什么不能像 filmcraft 那样移植

同仓的 `otools-filmcraft` 移植 [storytold/filmcraft](https://github.com/storytold/filmcraft) 的
方式是「上游 UI 原封不动编译到 WebAssembly」。concat 没有这条路径：

1. Slint + wgpu 依赖原生 GPU 栈，WebView 里没有可用的 WebGPU；
2. `ffmpeg-the-third` 动态链接 libav C 库，WASM 化等于重做 ffmpeg.wasm；
3. whisper.cpp / ONNX Runtime 都是原生二进制。

因此本插件是**重新实现**（clean-room）：只复刻上游的产品体验与「本地优先、离线处理」的立场，
不引用其任何源码/文案/locale（AGPL + 商标风险为零）。功能按分期对齐上游。

## 分期路线

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| v0.1 | 架构 + 端到端：媒体库、多轨时间线（视频/音频/文字）、剪切/拼接/变速/音量/静音、eq 滤镜预设、文字覆盖层（QOI）、H.264/AAC MP4 导出、工程持久化、8 语种 i18n | ✅ 本次 |
| v0.2 | 转场（xfade/擦除）、关键帧（位置/缩放/旋转/不透明度/音量 + 曲线）、变速曲线、更多滤镜/LUT | 计划 |
| v0.3 | AI 字幕（whisper.cpp/onnx 侧车化，模型按需下载——同上游模式）、语音隔离、增强/稳定 | 计划 |
| v0.4+ | 多时间线、代理剪辑、HEVC/AV1/GIF 导出预设、贴纸/形状、MCP/automation（上游有 MCP 先例） | 计划 |

## 与上游的架构对应

| 上游（Rust 原生） | 本插件（OTools webview + sidecar） |
| --- | --- |
| Slint GUI | Vue 3 + 自绘 DOM 时间线/预览 |
| concat-media（FFmpeg 绑定） | `concatd` sidecar 子进程驱动 ffmpeg/ffprobe CLI |
| JSON-RPC 自动化 API | loopback HTTP + Bearer（sidecar 协议同 uniplayer） |
| 本地模型目录 | （v0.3 计划）按需下载到插件缓存 |
| 27 语种 locale | OTools 宿主标准 8 语种（宿主切换不到的语种暂不收录） |

## 已知差异（v0.1）

- 图片导入仅 jpg/jpeg：uniplayer 源码锁 FFmpeg 构建未编 zlib → 无 PNG 解码；
  文字覆盖层改用 **QOI**（ffmpeg 内建无损 RGBA 编解码器，前端纯 TS 编码，见 `src/render/qoi.ts`）。
- 预览对不兼容容器/编码走 remux/proxy 通道（同 uniplayer copy/transcode 两档）。
- 文字以「canvas 全画幅透明图 + overlay enable 时间窗」实现，暂不支持逐字动画（上游有）。
