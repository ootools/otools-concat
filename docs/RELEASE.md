Concat v0.1.1 增加 Windows x64 和 Linux x64 平台包，保留 macOS Apple Silicon。

- 每个平台随包提供 concatd、FFmpeg 9.0.2 / x264；无须额外安装媒体工具。
- 保留中文、英文、日文、韩文、德文、俄文、西班牙文及阿拉伯文。
- 在各平台 CI 验证运行时、中文/空格路径、工程保存覆盖与打开、视频探针、缩略图及带音轨/滤镜/文字覆盖层的 MP4 导出。
- 修复多平台打包和异步运行时校验；市场按平台下载，不提供不存在的架构地址。

平台：Windows x64（Windows 10+）、Linux x64（glibc 2.35+，例如 Ubuntu 22.04+）、macOS arm64（macOS 12+）；OTools 0.9.8+。Windows ARM、Linux ARM 和 Intel Mac 暂无本版本资产。验证为原生 CI 服务与媒体流程，未进行三平台宿主 GUI 逐界面人工验收。
