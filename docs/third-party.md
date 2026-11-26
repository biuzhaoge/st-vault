# 第三方组件声明

**简体中文** · [English](third-party.en.md)

ST-Vault 原创源码采用 Apache-2.0。依赖和系统组件仍适用其各自许可，本仓库不重新授予或改变这些许可。以下说明不替代上游 LICENSE/NOTICE 原文。

发布构建按浏览器实际打包的依赖生成许可清单，包含 React 的间接依赖 scheduler 以及按需加载的 Hls.js。运行实例提供 `/assets/third-party-licenses.md`，容器内路径为 `/app/apps/ui/dist/assets/third-party-licenses.md`。独立上游声明随容器保存在 `/app/licenses/`。

- Node.js 与 npm：遵循官方 Node 镜像随附的上游声明。
- Fastify、React、Vite、Zod、Prettier、i18next、react-i18next：MIT。
- 时区计算使用 `@date-fns/tz`（MIT），随应用保留[上游许可](../licenses/date-fns-tz.txt)。
- node-postgres（pg）及其运行依赖：保留安装包内的上游声明。PostgreSQL 内置于运行和 QA 镜像，采用 PostgreSQL License；重新分发数据库镜像或二进制时保留 `/usr/share/doc` 中的声明。
- Hls.js、Playwright、TypeScript：Apache-2.0。
- Chromium（仅 QA）：来自 Debian 软件包，重新分发镜像时保留发行版组件声明并遵循各自许可。
- 运行时 FFmpeg 使用上游 5.1.10 发布源码、原生解码器及 libdav1d，启用本地 MP4/JPEG 处理链，禁用 GPL 和 nonfree 组件。Docker 的 `media-build` 阶段使用 Debian 编译加固选项，通过 `deploy/build-ffmpeg.sh` 构建。QA 使用 Debian 完整 FFmpeg，可能包含 GPL 组件。

构建按 SHA-256 固定上游归档，并使用 FFmpeg 官方发布密钥验证分离签名，密钥指纹为 `FCF986EA15E6E293A5644F10B4322F04D67658D8`。源码保留 Debian Bookworm 的范围编码器补丁和上游 MOV 清理、低位深原始视频两项修复。`/usr/local/share/doc/ffmpeg/` 随附实际编译的补后源码、许可证、配置日志、三份补丁，以及上游原始归档对应的签名与公钥。[官方签名发布](https://ffmpeg.org/download.html#verify) · [Debian 补丁](https://sources.debian.org/patches/ffmpeg/7%3A5.1.9-0%2Bdeb12u1/) · [MOV 修复](https://github.com/FFmpeg/FFmpeg/commit/969c7eb091989a664cb7bf66a1f02051cc46cb52) · [原始视频修复](https://github.com/FFmpeg/FFmpeg/commit/01a395b935b9da12dbeca588a7130c4db6a14689)

使用离线源码时，将已核验的上游归档命名为 `ffmpeg.tar.xz`，单独放在一个目录中，向 Docker Buildx 传入 `--build-context ffmpeg-source=<目录>`。在线和离线两种方式均由媒体阶段校验发布签名。编译器与软件包依赖另行准备。

第三方产品名称与 API 引用只说明兼容性，不代表隶属或背书。应用标识沿用原有 ST-Vault 项目资产；新增资产须确认权利后再提交。

准确版本见 package-lock.json；完整条款见各安装包的 LICENSE/NOTICE 及镜像中的 /usr/share/doc。
