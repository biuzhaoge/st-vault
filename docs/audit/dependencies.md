# 发布镜像依赖与安全公告

2026-11-24 至 25 日核验 Linux/amd64。最终代码 `5b31ca6a9` 的 amd64 生产镜像 ID 为 `sha256:8bfe6eb83690a0c09793383838165d5fb8d9b1d98096582d366af5e76c7edb4b`。最后的产品修订 `db4a143b3` 与该镜像的 16 个 RootFS 层逐层相同。与前一产品版本 `d31482ef4` 的 5,242 个应用文件对照，变化限于 UI 入口 HTML、JS 与 CSS。下列发行版公告首先在依赖修订镜像 `d0d03e7a` 核查，再以最终版本的 105 个系统包、两份媒体补丁和实际解码复核。Node.js 已升到 24.22.3，FFmpeg 已回补两个适用于现有媒体管线的官方修订。PostgreSQL 为 18.7。Debian Bookworm 完整 tracker、发行版专用数据和 amd64 安全包索引均未检出已发布且应安装的安全修订。发行版还有未给出修订的记录，详见下表。

## 成品内的软件

| 组件               | 对照结果                                                                                                                                                                      | 验证范围                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js            | 基线为 24.22.1。成品为 24.22.3，内置 llhttp 9.4.4、Undici 7.30.2、SQLite 3.54.1、OpenSSL 3.5.9。11 月 11 日的官方安全更新含高、中、低等级事项。                               | 应用使用 HTTP/1、内置 fetch 和迁移路径的 node:sqlite。要求启用 HTTP/2 或 TLS 服务端的公告还取决于配置。以成品 `process.versions` 核对这些内置副本。[发布镜像](../../deploy/Dockerfile#L53) · [官方安全公告](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases) · [发布说明](https://nodejs.org/en/blog/release/v24.22.3) |
| PostgreSQL / libpq | 镜像内 `postgres --version` 为 18.7，PGDG 版本为 18.7-1.pgdg12+2。固定摘要的来源镜像提供 postgresql-18 同一源版本的服务器、客户端和 libpq。检查日 18.7 为官方 18.x 最新修订。 | 服务使用本机 Unix socket。版本与 18.x 官方安全表匹配。PG 来源镜像另带 tzdata，版本与运行时包数据库相同，均为 2026f-0+deb12u1。[打包来源](../../deploy/Dockerfile#L17) · [官方版本支持](https://www.postgresql.org/support/versioning/) · [18.x 公告](https://www.postgresql.org/support/security/18/)                                           |
| FFmpeg             | 版本字符串为 5.1.9。随附源码 changelog 标识 Debian 源版本 7:5.1.9-0+deb12u1，构建另带下述两份官方修订。                                                                       | 实测输入/输出协议只有 pipe，输入 demuxer 为 MOV、MJPEG，输出 muxer 为 image2pipe、rawvideo。未启用硬件加速器。[编译选项](../../deploy/build-ffmpeg.sh#L26) · [截图入口](../../apps/server/src/previews/ffmpeg.ts#L56) · [Debian 包状态](https://security-tracker.debian.org/tracker/source-package/ffmpeg)                                      |

## ARM64 媒体验证

在 ARM64 用户态模拟器中，成品的 Node、PostgreSQL 和 FFmpeg 均为 AArch64 可执行文件。用 Debian GCC 12 交叉构建的 FFmpeg 与原生目标配置逐一比对，15 类功能开关的集合一致。成品在两种架构上的解码器、编码器、滤镜、协议、硬件加速、复用器、解复用器和 bitstream filter 八份清单相同。三个正常样片均经实际 ARM64 FFmpeg 生成 JPEG，再解码为 256 个灰度值。与 amd64 比较，H.264 的灰度相同，PAL8 和 AV1 分别有 32 和 34 个像素相差 1 个灰度等级。实测的软件包、配置、样片输出与哈希在交付证据包的 arm64-cross/ 中，物理 ARM NAS 的处理延迟仍待实机观测。[部署编译选项](../../deploy/build-ffmpeg.sh#L26)

此外，在 ARM64 用户态模拟器由目标架构的 GCC 执行仓库原 FFmpeg 配方（含两份回补、make -j2），构建步骤实耗 3,562.5 秒。先以实际 ARM Node 从应用修订 `d31482ef4` 重新构建 TypeScript 和 Vite，并与该媒体层组装。这次 ARM64 平台 manifest 为 `sha256:fd23e684d25fefc682491d97cedcea260580d90937611766d88387aa9abf5b81`。默认 1 秒请求期限下的正式生命周期门禁、旧 SQLite 截图作业的迁移、重启与清理均通过。H.264、PAL8 和 AV1 各 256 个灰度值与独立 ARM 交叉构建逐个相同。ARM64 与 amd64 的 75 对 Debian 源包名与版本一致。证据包 arm64/native/ 含正式收据与镜像身份。[正式生命周期测试](../../tests/deployment/lifecycle.ps1#L64)

在最终产品 `db4a143b3` 上，以同一原配方媒体重新构建并组装了 ARM 应用。其平台 manifest 为 `sha256:208e0c504c199e0407bc462dba5b1acc0b430845d5bcd6a762bee99d0a866d90`。正式 1 秒门禁和另设的 5 秒对照均通过全部三个生命周期分支。旧库迁移首次启动及重启后均为 3 项完成、0 待办、0 失败，6 份原媒体的字节均通过校验。两种架构的 75 个 Debian 源包名及版本、七份发布 UI 的文件名及 SHA-256 全部相同。FFmpeg 二进制与上次目标架构原配方构建逐字节相同，三份合法样片均通过。对应收据在 arm64/native-b36/。最终验收代码与这一产品版本仅相差一份 Chromium 测试。

## FFmpeg 的两个回补

| 公告            | 匹配依据                                                                                                                                                                          | 构建与校验                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CVE-2026-107678 | 公告涉及 MOV 元数据清理。成品实际解析 MOV。CNA CVSS 4.0 为 5.7，中等级。5.1.9、5.1.10、7.1.5、9.0.2 及检查日 release/5.1 的相关函数一致。9.1 已采用迭代实现。                     | 回补只修改一个 C 文件。邮件补丁 SHA-256 为 `594a0cbca9527bc1edab7f76679af5a73cee23aadc878e2cc6a9001e22742c45`。成品修订函数与官方提交的函数 SHA-256 均为 `91815c15c9f907dd9bd523b96d40b93b85085c97d5c642a868b12b4c42152895`。[Debian 公告](https://security-tracker.debian.org/tracker/CVE-2026-107678) · [CNA 评级](https://nvd.nist.gov/vuln/detail/CVE-2026-107678) · [上游提交](https://github.com/FFmpeg/FFmpeg/commit/969c7eb091989a664cb7bf66a1f02051cc46cb52) |
| CVE-2026-125097 | 涉及 rawvideo 解码。合法 pal8 MOV 已通过截图入口等价参数的实际解码。H.264 录像本身选择 H.264 解码器，未测量线上 rawvideo 比例。CNA CVSS 4.0 为 4.8（中），CVSS 3.1 为 3.3（低）。 | 官方六行修订适用于 5.1.9 及上游 5.1.10。对两者的修前源码，正向零 fuzz 检查成功、反向检查失败。邮件补丁 SHA-256 为 `50d080e61d3fa4fbadcdeb153dc524f2ba6552acf80012218293383ea5d765e2`。[Debian 公告](https://security-tracker.debian.org/tracker/CVE-2026-125097) · [CNA 评级](https://www.cve.org/CVERecord?id=CVE-2026-125097) · [上游提交](https://github.com/FFmpeg/FFmpeg/commit/01a395b935b9da12dbeca588a7130c4db6a14689)                                        |

上游 5.1.10 仍缺少这两处修改。两份官方修订可在现有分支独立应用，保留原有格式与发布源档。构建校验补丁 SHA-256，按零 fuzz 应用，已含修订的源码接受反向校验，无法确认的上下文使构建失败。成品保留许可、原始补丁及实际编译源码。[回补逻辑](../../deploy/build-ffmpeg.sh#L4) · [随包源码](../../deploy/build-ffmpeg.sh#L21) · [5.1.10 MOV 相关源码](https://github.com/FFmpeg/FFmpeg/blob/n5.1.10/libavutil/encryption_info.c) · [5.1.10 rawvideo 源码](https://github.com/FFmpeg/FFmpeg/blob/n5.1.10/libavcodec/rawdec.c)

双补丁编译产物及最终发布镜像分别通过正常样片验证。1,725 B 的 H.264 fMP4 转为 242 B JPEG，5,870 B 的 pal8 MOV 转为 2,257 B JPEG，两张 JPEG 再次解码为 16×16 灰度图，均为 256 B。成品 `/usr/local/share/doc/ffmpeg/source.tar.gz` 中 rawdec.c 与 encryption_info.c 的 SHA-256 分别为 `9e7fe692ad5e2a145b5b94856ae3ba890d3d75aee0f95a6ea08c12e755a6e796`、`c54aa0a88e680a922bd535a590c9ad8695f23e472964b04037515a14a92729c2`。检查仅使用合成正常录像。[成品安装位置](../../deploy/Dockerfile#L79)

在最终验收镜像重新合成两份 16×16 彩色样片，H.264 MP4（1,744 B）和 pal8 MOV（3,054 B）分别产生 502 B 和 767 B JPEG，再解码均为 256 B 灰度图。前一组样片的尺寸另列于上段。原始结果见附件的 `jobs/delivery-ffmpeg.log`。

其他公告按平台和构建选项区分。CVE-2026-125255 需要未启用的硬件解码路径，CVE-2026-125227 的 32 位前提不适用于本次 amd64 成品。CVE-2026-125183 所在的上游 HEVC 源文件在 5.1 树中布局不同，补丁所改的 `pps_3d_extension` 符号不存在，需分支级语义核实。其余开放记录的产品可达性未逐一验证。迁移 FFmpeg 9.1 须重新验证 H.264、HEVC、AV1、MJPEG 和跨架构构建。[硬件路径公告](https://security-tracker.debian.org/tracker/CVE-2026-125255) · [32 位公告](https://security-tracker.debian.org/tracker/CVE-2026-125227) · [HEVC 公告](https://security-tracker.debian.org/tracker/CVE-2026-125183) · [上游分支](https://ffmpeg.org/download.html)

## Debian Bookworm 系统包

实际执行 `dpkg-query -W` 并逐行对比二进制包名、二进制版本、源包名、源包版本。基线镜像 `sha256:bb9c7930fd94d9cecc3aa7316d03352e1ab37fb2f4897ea101ea961e8e5516fb` 和交付镜像均有 105 行，差异 0。两份按 dpkg 顺序、字段间制表符、每行 LF 归一化的清单 SHA-256 均为 `5bf6e263bd66f6f11f630aa00b151cad1cef61fff7512e5c69aa14970adbc640`。75 个由 dpkg 管理的源包，加自编译 FFmpeg，共 76 个 Debian 源包。PGDG 和 Node 的复制品按上节单独核对。

| 数据源                                     | 覆盖与结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Debian Bookworm 专用 debsecan 全量数据     | 压缩 1,955,487 B，zlib 完整解压 20,353,659 B。77,490 条公告定义和 80,433 条发行记录全部解析。按 Debian 工具 0.4.20.1 的 package、unstable_version、other_versions、fix_available 规则匹配，以 `dpkg --compare-versions` 比版本。48 个源包有历史 CVE 行，28 个没有对应记录。待安装且标注发行版已提供修复的源包/CVE 对为 **0**。另有 **317** 对未标注发行版有修复，其中 316 未分配 urgency、1 个 low。FFmpeg 的名义版本占 208 对，版本匹配会继续报告已本地回补的条目。压缩数据 SHA-256 为 `8e971c280abcfe3bf44aa888b51aa7cb68f1269ed2651556956d963b0f61c26c`。[发行版数据](https://security-tracker.debian.org/tracker/debsecan/release/1/bookworm) · [Debian 工具手册与局限](https://manpages.debian.org/bookworm/debsecan/debsecan.1.en.html) |
| Debian 安全仓 bookworm-security/main amd64 | Packages.xz 完整校验通过，成品的 Debian Archive keyring 给出有效的 InRelease 签名，签名中的 SHA-256 与实际文件相同，含 3,031 个二进制包记录，和成品包名相交后覆盖 19 个源包。还原 source:Version 后，成品低于渠道版本的二进制包为 **0**。压缩数据 SHA-256 为 `9d6bc73690ea9513106741c506c161b9e9c8cddeca9ddfe4a715f3d9acc161d8`。[官方 amd64 索引](https://deb.debian.org/debian-security/dists/bookworm-security/main/binary-amd64/Packages.xz)                                                                                                                                                                                                                                                                                              |

另独立取得完整跨发行版 tracker。21 个 gzip 分段的范围、字节数与 Last-Modified 均一致（2026-11-24 15:27:54 UTC），GZIP 校验和及完整 JSON 解析通过。压缩 15,362,332 B、解压 92,505,012 B，JSON SHA-256 为 `62a6078d13b6449da3bae015d6be97180205d606c868e95f2bf2786ceb24adff`。全库有 4,217 个源包。目标 76 个源包中，55 个有 tracker 历史记录，21 个没有对应源包项。按 Bookworm 和 CVE 编号比对，1,922 对为 resolved，按 dpkg 比较发现随包版本低于该发行版 fixed_version 的情形为 **0**。另有 **369 对 open**（319 未评级、49 unimportant、1 low）和 **2 对 undetermined**（FFmpeg 与 PAM 各一）。FFmpeg 名义版本有 212 对 open，其中包括两项已按源码验证的本地回补。debsecan 使用不同的记录集合和发布状态表示，因此保留两种口径。缺少历史记录不能证明产品可达性，也不能证明软件安全。CNA 的 CVSS 与 Debian urgency 分别列示。[跨发行版 tracker](https://security-tracker.debian.org/tracker/data/json) · [Bookworm LTS](https://wiki.debian.org/LTS/Bookworm)

复跑可在无业务挂载的交付镜像执行以下只读命令，另在隔离的 Bookworm 工具容器用 `debsecan --suite bookworm --status <运行时导出的 dpkg 状态文件>` 匹配真实运行包。自编译 FFmpeg 需在状态文件副本补登记源版本 `7:5.1.9-0+deb12u1`，并独立核对附带修订。当日完整输出位于 `.local/audit-closure/jobs/` 下的 `release-vendor.log`、`release-ffmpeg-smoke.log`、`os-debsecan.log`、`os-matches.log`、`os-security-packages.log`、`os-security-index-signature.log`。后续用实时源复跑时应记录快照日期和哈希。

```sh
dpkg-query -W -f='${Package}\t${Version}\t${source:Package}\t${source:Version}\n'
node -p 'process.versions'
postgres --version
ffmpeg -version
sha256sum /usr/local/share/doc/ffmpeg/*.patch
```

### 开放记录的升级对照

交付附件的 `jobs/debian-open-register.json` 逐条列出 Bookworm 的 369 项 open 和 2 项 undetermined，并附镜像源版本、官方公告、已验证的本地回补和同一快照中 Debian 13 Trixie 的状态。对应的 371 项在 Trixie 中有 66 项列为 resolved、303 项 open、2 项 undetermined。66 项中包括 krb5 的 18 项、glibc 的 16 项和 FFmpeg 的 11 项。发行库间的对照可用于评估升级收益，不能据此推定新版二进制与现有基础层兼容。[Debian Security Tracker](https://security-tracker.debian.org/tracker/)

成品的 `ffmpeg -decoders` 列出 455 个解码器条目，其中视频 237、音频 196、字幕 22。截图命令限定 MP4 输入并选择第一路视频，关闭音频、字幕及数据输出。实际选择还取决于封装内的编解码标识。报告按输入协议、解封装器、目标流、具体回补分别判定，不能将解封装器数量径直当作解码器数量。完整列表保存在附件的 `jobs/delivery-decoders.txt`。[构建选项](../../deploy/build-ffmpeg.sh#L26) · [取帧参数](../../apps/server/src/previews/ffmpeg.ts#L53)

## 直接生产依赖的维护状态

核对根和三个 npm 工作区的 dependencies，并按 lockfile 的实际安装位置读取版本。根没有直接生产依赖。共 10 个不同的直接生产包名，其中 9 个为外部 npm 包，1 个为本仓私有包。表内日期为 UTC。registry 观测时点为 2026-11-24 15:59:52 UTC，仓库状态在其后三分钟内核实。

| 包              | 使用方         | 锁定版本及发布日      | npm latest 及正式发布日 | 官方来源                                                                                                        |
| --------------- | -------------- | --------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `@date-fns/tz`  | UI             | 1.5.0（2026-05-21）   | 1.5.0（2026-05-21）     | [npm 元数据](https://registry.npmjs.org/@date-fns%2Ftz) · [未归档仓库](https://github.com/date-fns/date-fns)    |
| `fastify`       | 服务端         | 5.12.7（2026-10-13）  | 5.12.8（2026-11-02）    | [npm 元数据](https://registry.npmjs.org/fastify) · [未归档仓库](https://github.com/fastify/fastify)             |
| `hls.js`        | UI             | 1.7.4（2026-10-28）   | 1.7.4（2026-10-28）     | [npm 元数据](https://registry.npmjs.org/hls.js) · [未归档仓库](https://github.com/video-dev/hls.js)             |
| `i18next`       | UI             | 26.7.2（2026-11-05）  | 27.2.7（2026-11-24）    | [npm 元数据](https://registry.npmjs.org/i18next) · [未归档仓库](https://github.com/i18next/i18next)             |
| `pg`            | 服务端         | 8.23.1（2026-09-30）  | 8.23.1（2026-09-30）    | [npm 元数据](https://registry.npmjs.org/pg) · [未归档仓库](https://github.com/brianc/node-postgres)             |
| `react`         | UI             | 18.3.1（2024-04-26）  | 19.3.1（2026-10-14）    | [npm 元数据](https://registry.npmjs.org/react) · [未归档仓库](https://github.com/react/react)                   |
| `react-dom`     | UI             | 18.3.1（2024-04-26）  | 19.3.1（2026-10-14）    | [npm 元数据](https://registry.npmjs.org/react-dom) · [未归档仓库](https://github.com/react/react)               |
| `react-i18next` | UI             | 17.1.13（2026-11-05） | 18.0.3（2026-11-19）    | [npm 元数据](https://registry.npmjs.org/react-i18next) · [未归档仓库](https://github.com/i18next/react-i18next) |
| `zod`           | 服务端、契约包 | 4.6.7（2026-10-12）   | 4.6.7（2026-10-12）     | [npm 元数据](https://registry.npmjs.org/zod) · [未归档仓库](https://github.com/colinhacks/zod)                  |

内部包 `@st-vault/api-schema` 由服务端及 UI 使用，通过 workspace 链接解析到本仓 0.1.1，清单标记 private，维护与发布跟随本项目。其直接依赖 zod 已计入上表。

9 个锁定版本在 npm 官方 registry 均没有 deprecated 标记。包元数据指向的 8 个不同源码仓库均在 GitHub 官方页面显示 isArchived=false。react 与 react-dom 共用 React 仓库。@date-fns/tz 的 1.5.0 包元数据指向 date-fns/date-fns；额外核对组织下的 tz 仓库，其页面也显示未归档。[tz 仓库](https://github.com/date-fns/tz)

表中 latest 均为正式版本。若按实际发布时间在所有非预发布版本间排序，React 两包同日还稍晚发布了旧分支 19.1.10；其余七包的最近正式发行与 latest 一致。

Fastify 公布主版本 LTS 及下一主版本发布后的安全维护窗口，当前锁定版本与 latest 相差一个补丁。React 的版本政策承诺向确受安全问题影响的主版本回补；旧版本的普通修复范围另依该政策。React、React DOM、i18next 和 react-i18next 的锁定主版本低于各自 latest。其余包核实的是各版本发布与仓库归档状态，本次未取得这些锁定分支的固定维护年限或响应 SLA。[Fastify LTS](https://fastify.dev/docs/latest/Reference/LTS/) · [React 版本政策](https://react.dev/community/versioning-policy)

本机证据文件 maintenance-registry.json 保存逐包版本、UTC 发布时间、dist-tag、deprecated 状态与来源；maintenance-repos.json 保存逐仓归档状态与观测时刻。GitHub REST 的匿名配额已耗尽，归档状态取自各官方仓库页面的结构化字段。

## 2026-11-25 晚间复审的媒体修订（O01）

上文 105 个系统包、369 项 open 和 2 项 undetermined 对应原 B37 生产镜像及当时的 Bookworm 快照。本轮将自编译 FFmpeg 从 5.1.9 升至同分支 5.1.10。Bookworm 的 FFmpeg 安全源仍为 5.1.9，目标发行包也没有随此修改升级。Node.js 24.22.3 和 PostgreSQL 18.7 与当天各自维护分支的官方版本一致。[FFmpeg 发布分支](https://ffmpeg.org/download.html) · [Debian FFmpeg 源包](https://security-tracker.debian.org/tracker/source-package/ffmpeg) · [Node 安全发布](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases/) · [PostgreSQL 18.7](https://www.postgresql.org/docs/release/18.7/)

- **已核实的修订**。Debian 将缩放器 CVE-2026-38347 和 MagicYUV 解码器 CVE-2026-8461 分别映射到上游 5.1.10 的 `7ee2f900`、`0216a484`。应用的截图命令会调用缩放器，正常的 MagicYUV MOV（M8Y2）也能从实际管线输出 JPEG。本轮保留 Debian 的范围编码器补丁及先前核实的 MOV 清理、低位深原始视频两项回补。[缩放器公告](https://security-tracker.debian.org/tracker/CVE-2026-38347) · [MagicYUV 公告](https://security-tracker.debian.org/tracker/CVE-2026-8461) · [应用取帧命令](../../apps/server/src/previews/ffmpeg.ts#L53)
- **可信输入与源码交付**。上游归档 SHA-256 为 `392306d6fc45dab0e9e0ea55381e071842e83a2fb31d320aeda40477a7766293`。官方签名通过，签名指纹与 Debian 签名源包携带的上游公钥一致。对无关的普通许可证文本验同一签名返回失败。新构建在编译前归档刚补完的源码，消除了此前先编译后清理会留下目标专用中间文件的情况。[下载与验签](../../deploy/Dockerfile#L29) · [归档时机](../../deploy/build-ffmpeg.sh#L19)
- **产物加固**。此前两个架构均未设置立即绑定，amd64 原程序也未导入所核对的栈保护及强化 libc 函数。新媒体构建使用 Debian `dpkg-buildflags`，启用立即绑定。链接后检查 GNU_RELRO、BIND_NOW、`__stack_chk_fail` 和强化 libc 调用。旧版程序在新检查中失败。[编译标志](../../deploy/build-ffmpeg.sh#L23) · [链接产物检查](../../deploy/check-ffmpeg-elf.sh#L16) · [Debian 工具说明](https://manpages.debian.org/bookworm/dpkg-dev/dpkg-buildflags.1.en.html)

媒体门禁使用普通合成画面，覆盖 H.264、另含 AAC 的 H.264、HEVC、AV1、VP9、PAL8、QTRLE、MJPEG 和 MagicYUV。每个目标均通过实际输入选择、缩放并输出 JPEG，再解码为 16×16 灰度。amd64 使用原 `media-build` 与同版本 Debian 工具。arm64 使用 GCC 12 的 AArch64 交叉编译及固定的 Debian 目标库，后续解码在 QEMU 的 ARM64 生产用户态运行。此轮没有物理 ARM 或 NAS 性能测量。

| 旧版与新版的实际对照                                                             |             linux/amd64 |             linux/arm64 |
| -------------------------------------------------------------------------------- | ----------------------: | ----------------------: |
| 正常媒体及各自与旧版相同的灰度值                                                 |      10/10，2,560/2,560 |      10/10，2,560/2,560 |
| 注册表逐字相同（解码器、编码器、解封装、封装、协议、滤镜、比特流滤镜、硬件加速） |                     8/8 |                     8/8 |
| 旧版 / 新版 FFmpeg 字节数                                                        | 13,904,544 / 14,058,968 | 11,414,088 / 11,543,936 |

实际注册 455 个解码器，视频 237、音频 196、字幕 22。两个架构的发布源码归档字节相同，SHA-256 为 `e61f08e0e59a54da1ad6a9b60e177955263cb00a86e8beaf540594a045c64e26`。各自解压后与独立按签名原件重放三补丁的 7,797 个文件逐项一致。构建器直连官方 URL 的校验和下载，以及离线 source context 的发布构建均已实测，两个来源逐字相同，生产媒体阶段另行验证官方签名。原始比对、归档、ELF 和样片记录位于 `.local/followup-134/media/`，入口为其中的 `RESULTS.md`。

仍需跟踪上游 5.1 分支与发行版公告。编译加固不能用来扣减 CVE 数量，旧 Debian 包版本的名义开放数也不能直接作为此自编译程序的剩余计数。有依赖特定流、可选硬件或不同分支代码的公告，需按实际配置和修订逐项确认。[Debian 跟踪记录](https://security-tracker.debian.org/tracker/source-package/ffmpeg)
