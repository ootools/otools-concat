# SPEC · otools-concat

本地优先的快剪视频编辑器插件（CapCut 式），灵感来自 jub0t/concat（见 `UPSTREAM.md`）。

## 定位

- 与 `otools-filmcraft`（Premiere 式全功能、上游 WASM 移植）错位：Concat 走 CapCut 式轻快剪。
- 全部媒体处理在本机完成，无网络上传、无遥测；导出走自带 FFmpeg。
- 插件形态：`openMode: tabs` + `instanceMode: multiple`（每工程/每素材一个标签实例），
  sidecar `concatd`（Rust/axum，stdio 握手 + loopback HTTP + Bearer，协议与 uniplayer 同款）。

## 核心概念

- **工程** `.concatproj`（JSON v1）：媒体库（引用源文件绝对路径）+ 轨道 + 片段 + 导出设置。
  打开工程时对每个媒体重新 probe（路径可能移动）。
- **轨道**：1 视频主轨（线性拼接，不允许重叠）+ N 音频轨（绝对时间放置）+ N 文字轨（允许重叠）。
- **片段**：`{start, in, out, speed, volume, muted, filter?, text?}`；时间线时长 = (out-in)/speed。
- **渲染计划**：`src/render/plan.ts` 纯函数编译 filter_complex（trim/setpts/eq/scale/pad/fps/
  concat + atrim/atempo/volume/adelay/amix + 文字 QOI overlay enable 窗口），sidecar 只做
  argv 组装与进程管理（质量档位 fixed：crf 20/23/28，aac 192k，movflags +faststart）。

## concatd API（loopback，Bearer 或 GET ?access_token=）

| 路由 | 说明 |
| --- | --- |
| `POST /api/probe {path}` | ffprobe → `{mediaId, info, previewMode}`（媒体注册后才能被引用） |
| `GET /api/media/{id}` | 原始字节（Range 流式） |
| `GET /api/media/{id}/preview.mp4` | 预览：browser（原样）→ remux（换容器 copy）→ proxy（H.264/AAC 低清转码），产物缓存 |
| `GET /api/media/{id}/thumb.jpg?at=` | 缩略图（0.1s 分桶缓存） |
| `GET /api/media/{id}/peaks.json` | 音频波形 RMS 峰值（8k 单声道 → 2000 桶） |
| `POST /api/assets/text {dataBase64}` | 文字覆盖层图片（PNG/QOI 魔数校验）→ `{assetId}` |
| `POST /api/render` | 提交渲染：`{inputs[{path\|lavfi,loopImage?}], filterComplex, expectedDuration, output, quality, hasAudio}`；输入必须是已注册媒体/资产；输出必须绝对路径 .mp4 |
| `GET /api/render/{id}` / `…/events` | 进度（轮询 / SSE）；失败带 ffmpeg stderr 尾部诊断 |
| `POST /api/render/{id}/cancel` | 取消（SIGTERM→SIGKILL，删除半成品） |
| `POST /api/project {path,dataBase64}` / `GET ?path=` | 工程文件读写（仅 .concatproj，≤16MB） |
| `POST /api/close` | 清缓存/杀任务 |

安全边界：监听 127.0.0.1 随机端口；host/origin 双重校验 + 常数时间 token 比对（`auth.rs`
原样复用 uniplayer）；错误信息固定字符串（不回显路径/token）；媒体引用必须先经 probe 注册；
查询 token 仅限 GET 媒体路由（`<video>/<img>` 无法设 header）。

## 媒体运行时

FFmpeg 9.0.2 + x264 r3222（源码锁 `runtime-source-lock.json`，GPL-3.0-or-later，macOS arm64
自包含静态构建）——构建管线与源码锁直接复用 uniplayer（见 `docs/MEDIA_RUNTIME.md`）。
**注意该构建 `--disable-autodetect` 无 zlib → 无 PNG 解码**：

- 图片导入仅 jpg/jpeg（mjpeg 内建解码）；
- 文字覆盖层用 **QOI**（ffmpeg 内建无损 RGBA 编解码器，前端 `src/render/qoi.ts` 纯 TS 编码）；
- v0.1.1 运行时覆盖 macOS arm64、Windows x64 和 Linux x64；各原生 CI runner 执行媒体与服务冒烟后才生成正式平台包。

## i18n（重点）

- `i18n/{zh-CN,en-US,ja-JP,ko-KR,de-DE,ru-RU,es-ES,ar-SA}.json`：扁平 lowerCamelCase key +
  `{placeholder}` 插值；en-US 为类型真源（`MessageKey`），缺 key 编译报错。
- `src/i18n.ts`：locale 跟随宿主（html[lang] → `otools:locale` → navigator.language），
  监听 `otools-locale-changed` + html[lang] MutationObserver；兜底链 locale→en-US→zh-CN→key。
- ar-SA 驱动 `dir=rtl`；布局用 CSS 逻辑属性自动镜像，时间线/预览显式锁 LTR（时间方向恒定）。
- `scripts/i18n-parity.test.mjs`：8 语种 key 集合/顺序/占位符/非空全等校验（打包前保险）。

## 脚本链

`npm run dev`（6578）/ `preview`（6579）/ `build`（vue-tsc + vite）/ `test`（scripts 25 测）/
`test:src`（strip-types 单测：plan 18 + qoi）/ `pack`（build+pack+verify）。

- `pack-plugin.mjs`：linuxdo 手写 ZIP + uniplayer 式 bin/resources 收集；`--platforms` 多平台（逐平台生成独立包），`--per-platform` 单平台也使用平台包名称；
  生产清单剥 devUrl/quickDev；meta.json 记录平台与 support 标志（如实上报）。
- `verify-plugin.mjs`：linuxdo 加固版（serde duplicateJsonKeys/caseVariant 碰撞）+ sidecar
  bin/ffmpeg 运行时存在性 + support 标志一致性。
- `smoke-concatd.mjs`：无宿主端到端冒烟（握手→probe→缩略图→QOI 上传→渲染→输出校验）。
- `build-media-runtime.mjs`/`verify-media-runtime.mjs`：uniplayer 原版（macOS arm64）。
- `publish-market.mjs`（+test）/`release-policy.mjs`（+test）：linuxdo 版（booleanInput 认
  1/0）；support 标志从 `dist-pack/meta.json` 读取如实上报。

## 发布

推 `v<版本>` 标签 → `.github/workflows/release-plugin.yml`（macos-15 runner：npm build →
cargo build concatd → ffmpeg 运行时构建 → pack → verify → Release）。市场上架三件套
（release env + `XYCLOUD_PAT` + `OTOOLS_PUBLISH_MARKET=true`）首次发布前配置（AGENTS.md）。

## 已知限制（v0.1）

- 预览播放：跨片段切换有加载间隙；音频轨同步容差 0.25s；图片片段用墙钟推进。
- 文字为整段覆盖层（无逐字动画/轨道遮罩）；转场、关键帧、变速曲线在 v0.2。
- 无 AI 功能（v0.3 起，模型按需下载）。
