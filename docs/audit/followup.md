# 四项审查发现的后续处理

本轮从首次审查交付提交 `9207ab9a6` 开始。基线的 49 项登记、原始测试和回滚说明见[首次审查报告](REPORT.md)。

## O01 · 媒体和系统包

FFmpeg 从 5.1.9 升到同分支 5.1.10。构建核对归档的 SHA-256 和上游签名，保留两份已有安全回补及 Debian 的编码器修订。缩放器和 MagicYUV 解码器均是这个产品启用的组件，5.1.10 含各自的上游修复。构建还检查成品 ELF 的栈保护、强化内存复制和完全只读的重定位表。两个架构各用十份正常样片取帧，每个架构的 2,560 个灰度采样值与自己的旧版本完全相同。随二进制分发的源码与实际编译输入逐文件相同，两个目标的源码归档 SHA-256 也一致。[成品对照](dependencies.md) · [FFmpeg 的签名发行包](https://ffmpeg.org/download.html) · [缩放器公告](https://security-tracker.debian.org/tracker/CVE-2026-38347) · [MagicYUV 公告](https://security-tracker.debian.org/tracker/CVE-2026-8461)

双架构发布工作流在推送前读取待发布镜像的 dpkg 库，用 APT 校验本架构 Debian 安全仓库的签名、日期和包清单。已安装版本落后、缺少索引或索引校验失败都会中断发布。该检查针对当前安全频道有条目的二进制包。其他系统包、单独复制的 PostgreSQL 和 Node.js、自编译的 FFmpeg 仍按各自来源核验。上游未发布修订的公告继续保留在依赖报告中。[发布检查](../../scripts/check-debian-security.mjs) · [工作流](../../.github/workflows/dockerhub.yml)

## O02 · 状态面板

产品采用工作台状态面板作为单管理员的故障入口。运维人员可以查看归档异常、磁盘不足、站点不可用和后台重试的原因。本轮重新验证三个状态组件测试文件，15 项全部通过。按确认的产品范围关闭此项。[状态面板测试](../../apps/ui/src/features/status/SystemSummary.test.tsx) · [后台故障显示](../../apps/ui/src/features/status/background-status.test.ts)

## O03 · 工作台读取

24 个可见主播的归档调用从 48 次降为 24 次。每行在同一只读快照里读取录像覆盖和直播状态。如果该主播在窗口里没有对应标记或待处理收藏，就跳过相应的聚合查询。一个已预热、有录像和状态且没有个人标记的单人请求，在 PostgreSQL 驱动上实测从 12 次调用降到 5 次，两侧均计入事务开始和提交。[工作台入口](../../apps/server/src/http/workbench.ts) · [覆盖与个人标记](../../apps/server/src/archive/coverage-reader.ts)

| 24 个主播，合成负载 p95      | 首次验收版本 |  本轮版本 |
| ---------------------------- | -----------: | --------: |
| 单个请求，无个人标记         |    224.95 ms |  93.04 ms |
| 单个请求，8 人有个人标记     |    167.63 ms | 117.41 ms |
| 三个并发请求，无个人标记     |    549.50 ms | 187.05 ms |
| 三个并发请求，8 人有个人标记 |    561.75 ms | 354.06 ms |

两种数据分布各做三轮。在 96 次并发检查中，单人请求均先于三条长请求完成，超过并发上限的请求均收到 429，断连后新增派读为零。首次独立容器实验里，竞争时回放定位 p95 曾从 24.11 增到 44.34 ms，同时空闲时间线延迟也上升。固定 CPU、在同一 PostgreSQL 中交错两个版本重测后，每版 270 个在途回放探针的 p95 为 33.44 和 29.70 ms，空闲回放为 9.28 和 9.70 ms。首次结果及复测均已保留。目标 NAS 的硬件和生产负载待实测。[数据、重复轮次与边界](api-data.md)

## O04 · 工作台与归档模块

工作台入口从 1,181 行减到 375 行。视窗恢复、数据刷新、播放源切换、截图复核窗口各有明确的状态所有者。传输层集中处理回放和直播租约，使取消请求与释放已拿到的租约可以独立验证。[工作台](../../apps/ui/src/App.tsx) · [播放协调](../../apps/ui/src/app/use-workbench-playback.ts) · [租约与续播的测试](../../apps/ui/src/features/player/playback-requests.test.ts)

归档门面把物理对象交给媒体存储模块，文件路径、摘要、临时文件改名、目录同步和首次读取校验由该模块维护。归档事务仍决定何时发布元数据以及何时确认物理删除。录像单元回填模块单独负责共享任务、取消等待及关停排空。测试覆盖重新打开后读回媒体、删除其中一个对象、断电恢复路径、完整性与取消。物理存储与元数据的职责划分也参考了 restic 的本地后端，其持久化流程将文件同步和原子改名放在本地对象的写入操作中。[对象存储](../../apps/server/src/archive/object-store.ts) · [回填与取消](../../apps/server/src/archive/unit-index.ts) · [归档回归](../../apps/server/src/archive/archive.test.ts) · [restic 本地存储实现](https://github.com/restic/restic/blob/master/internal/backend/local/local.go)

归档门面从 1,952 行降至 1,713 行，元数据 worker 从 1,909 行降至 1,680 行。独立的覆盖率读取、媒体对象存储、回填协调分别为 286、227、87 行。门面仍负责协调元数据提交、删除和恢复。UI 主 JavaScript 在相同 gzip 参数下增加 809 字节，CSS 与 HLS 文件的 SHA-256 保持一致。[覆盖率读取](../../apps/server/src/archive/coverage-reader.ts) · [归档入口](../../apps/server/src/archive/index.ts)

## 整体验收

受测代码提交为 `8ebbadabe`。Docker 中的完整检查通过，共 1,527 项测试，其中工具 22、服务端 924、UI 574、契约 7。格式、lint、类型、仓库边界检查和发布构建均通过。Chromium 依注册顺序完成 43/43 个端到端场景，覆盖截图操作、播放、会话、删除和设置。[检查入口](../../package.json) · [浏览器场景注册表](../../scripts/run-browser-tests.mjs)

Linux WebKit 27.2 在断网容器中加载相同的发布 JS 和 CSS，使用浏览器原生触摸输入验证截图交互。单点定位播放，双点恰好产生一次收藏写入。一次 618 ms 的可信长按选中 3 张。跨页拖选、反选、回撤、区外点按清空并抑制跳播、批量按钮和粉色收藏框也通过。[截图交互场景](../../tests/e2e/snapshot-gestures.mjs)

amd64 和 arm64 成品各自通过关停、重启及数据库故障后的恢复检查。分别从旧 SQLite 样本迁移后，3 项截图任务均完成，JPEG 接口返回 200，6 份原录像逐字节一致，重启后检查点哈希相符。每个镜像有 105 个已安装的 Debian 包，其中 33 个出现在当天的官方安全索引，落后版本数均为 0。两种镜像的 7 份 UI 文件逐字节相同。ARM64 通过 QEMU 运行。实体 NAS、iPhone 和 GitHub 托管发布环境仍待实测，本次仅在本地构建和验证。[生命周期检查](../../tests/deployment/lifecycle.ps1) · [安全索引检查](../../scripts/check-debian-security.mjs)
