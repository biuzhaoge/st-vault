# 开发与维护

**简体中文** · [English](CONTRIBUTING.en.md)

本指南介绍构建、测试、发布与恢复。使用方法和接口见[使用手册](../README.md)、[架构](architecture.md)和 [API](api.md)。

参与修改时请附复现、相关测试及风险说明，行为变更同步修改对应文档。安全问题按 [SECURITY.md](SECURITY.md)私密反馈。两份文件集中在 docs，并沿用 [GitHub 支持的标准命名和位置](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file)，不在根目录保留重复入口。

## 仓库结构

| 路径                      | 内容                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/server`、`apps/ui`  | 服务端与前端；测试与所属模块相邻                                                         |
| `packages/api-schema`     | 共用类型与请求约束                                                                       |
| `compose.yml`、`deploy`   | 用户部署模板、开发覆盖配置、Dockerfile 和 FFmpeg 构建                                    |
| `scripts`                 | 构建/检查入口；benchmarks 为性能实验，diagnostics 为显式网络诊断，maintenance 为历史迁移 |
| `tests`                   | e2e 合成浏览器场景、runtime 运行探针、deployment 生命周期验证                            |
| `docs`                    | 全部说明文档，无按开发阶段划分的子目录                                                   |
| `licenses`、`LICENSE`     | 必须保留的法律声明，不属于可丢弃开发产物                                                 |
| `.github`                 | Issue 与 PR 模板、Docker Hub 发布工作流                                                  |
| `data`、`media`、`.local` | 忽略提交的正式状态、媒体和本机验证产物；不混入源码                                       |

根目录保留 npm/workspace 锁文件、TypeScript/ESLint/Prettier 配置、Git/Docker/editor 约束，避免为表面整洁增加自定义路径和工具参数。依赖只装在容器；构建输出 `build/`、`apps/ui/dist/` 不提交。

## 构建与检查

从仓库根执行，不挂载生产 data/media：

```sh
docker build --target qa -t st-vault:qa -f deploy/Dockerfile .
docker run --rm st-vault:qa npm run check
docker run --rm --entrypoint npm st-vault:qa audit --omit=dev --audit-level=high
docker run --rm st-vault:qa sh -ec 'npm run build && npm run test:browser'
```

`check` 包括格式、lint、文档链接与源码依赖边界、类型、工具/工作区测试和发布构建。QA 镜像内置临时 PostgreSQL，启用真实数据库集成测试；runtime 不带 npm、编译器或 Chromium。定向测试：

```sh
docker run --rm st-vault:qa npm test --workspace @st-vault/ui -- src/features/timeline/track-loader.test.ts
docker run --rm st-vault:qa npm test --workspace @st-vault/server -- src/database/postgres.test.ts
docker run --rm st-vault:qa sh -ec 'npm run build && node scripts/run-browser-tests.mjs sync-request-budget display-clock deletion-intent'
```

浏览器 fixture 在独立端口生成合成 HLS/JPEG，禁止外部网站请求；产物在 `.local/qa/`，临时状态正常结束后清理。`STV_QA_KEEP_STATE=1` 仅用于显式保留排障状态。不要将私人数据库、Cookies 或录像放进测试。UI、删除、媒体和持久层变更须覆盖相关浏览器、取消、迟到响应、中断及重启场景。

在同一个 QA 容器里先构建再运行浏览器用例，构建步骤会生成本地工作区依赖链接。`sync-request-budget` 检查删除列表复用、补读和恢复，以及只重读观测续期影响的可见行。排查请求放大时，按登录、空闲、滚动和媒体变化分别统计请求数、每个 `/api/workbench` 批包的行数以及取消请求数。

只迭代源码时可将对应 `src` 只读挂进 QA，不能挂载整个 apps 目录覆盖镜像内 workspace 依赖。依赖或构建配置变化后重新构建。直接运行编译后的业务入口不负责启动数据库；正式启动使用 `apps/server/src/deploy/start.js`（发布目录内路径）。构建标识 `STV_BUILD_REVISION` 仅接受 40–64 位小写十六进制，发布时传真实提交 SHA。

本地候选镜像通过独立数据环境启动检查后，才用开发 override 部署：

```sh
docker compose -f compose.yml -f deploy/compose.build.yml up -d --build
```

生产镜像生命周期验证使用 [lifecycle.ps1](../tests/deployment/lifecycle.ps1)，不连接正式数据。清理仅限已确认不用的验证产物和 Docker 资源；正式 data/media、必要回退备份与匹配镜像不能作为缓存删除。

已有部署可保留只读根文件系统、可写 `/tmp` 和额外的权限约束。原先自定义的运行身份继续通过 `STV_RUNTIME_UID`、`STV_RUNTIME_GID` 配置。只有 PostgreSQL 报共享内存空间不足时，才需要按宿主机资源调整 `shm_size`。

## PostgreSQL 存储

数据库固定使用数据目录下的 `postgres/18`，默认容器路径为 `/data/postgres/18`。Linux 或 NAS 上的本机文件系统部署可保留原挂载来升级。Windows Docker Desktop 或 SMB 上的 `data` 需要把数据库放到本机 Linux 存储。可以从 WSL 的 Linux 文件系统运行 Compose，也可以将本地 Docker 命名卷挂载到 `/data/postgres`。已有数据时，切换挂载前先将原集群恢复到目标存储。空卷会遮住原目录。

需要迁移不支持的挂载时，正常停止旧工作台，保留旧镜像、部署配置、`data` 和 `media`。用匹配的 PostgreSQL 版本在独立维护容器中启动旧集群，仅启用私有 Unix socket 供导出。Windows 共享盘上的旧集群导出期间可设置 `io_method=sync` 和 `default_transaction_read_only=on`。

1. 使用 `pg_dump --format=custom --no-owner --no-acl --file=stvault.dump stvault` 导出完整数据库。保管好导出文件，它包含私有设置。保留 `data/private/postgres.json` 及其余私有文件。
2. 在目标存储初始化空集群，沿用原部署的运行 UID/GID 和应用数据库凭据。用 `pg_restore --exit-on-error --no-owner --no-acl --dbname=stvault stvault.dump` 导入，核对业务和私有配置表的行数后再启动工作台。确认旧 PIN、账户和录像可用后，保留源集群和导出文件作为备份。

启动拒绝 9p 和 SMB 上的 PostgreSQL 集群目录及 WAL。状态面板检查实际数据库目录的容量和写入权限。崩溃诊断可在 `data/logs/supervisor.jsonl` 及其轮转文件搜索 `postgres_child_terminated`，事件记录子进程 PID 和信号，PostgreSQL 主进程恢复后仍可查询。

## 验证与发布

每次推送 `main` 或提交面向 `main` 的 PR 都只运行 CI。检查覆盖格式、类型、测试、构建、依赖审计和 Compose 配置。浏览器回归可按上文在本地运行。

1. 准备发版时，同步更新根目录与三个工作区 `package.json` 的版本和 `package-lock.json`，并在[更新日志](CHANGELOG.md)顶部添加对应的 `## X.Y.Z`，写明中英文用户可见变更和必要的升级说明。推送 `main`，等待 CI 通过。
2. 在 GitHub 打开 [Actions → Publish release](https://github.com/biuzhaoge/st-vault/actions/workflows/dockerhub.yml)，点击 **Run workflow**，选择 `main`。工作流以触发时的提交为准，从根目录 `package.json` 读取版本，并复用 CI。
3. 两个原生架构分别完成启动、关闭及数据库恢复测试后，工作流创建 `vX.Y.Z` 源码标签、`X.Y.Z` 双架构镜像和带更新日志的 GitHub Release。当前 `main` 的发布会更新 Docker Hub 的 `latest` 及 Overview。若 `main` 在构建期间前进，仍可通过固定版本取得结果。

同一版本的正式标签固定到对应源码和镜像，发布失败后可重跑原工作流。已成功发布的版本有新改动时递增版本号。`DOCKERHUB_TOKEN` 需有推送、更新 Overview 和删除临时标签的权限。GitHub Actions 日志保留 7 天，镜像由 [Docker Hub](https://hub.docker.com/r/biuzhaoge/st-vault) 提供。

## 旧部署升级

当前支持格式 1、业务元数据格式 5 的双目录 SQLite 库一次性导入 PostgreSQL。先正常停止旧应用，备份完整 data、media 和旧镜像；新镜像首次启动恢复已确认日志、冻结源库、导入校验并发布格式 2 检查点。冻结副本位于 `data/backups/postgresql-<库UUID>/<代际>/`，不能代替视频备份。需为旧库、副本、新集群、暂存表和 WAL 留足空间，不要在大库首次导入时反复强制重启。

旧单目录布局必须先使用匹配历史镜像中的 [migrate-library.mjs](../scripts/maintenance/migrate-library.mjs) 转成两个独立目录；不要直接用当前 latest 操作不匹配的旧库。工具要求正常关闭的格式 5 源，目标彼此独立且不在源内；同盘硬链接、跨盘复制校验，中断可重跑，保留源用于回退。

旧镜像不能读取新格式或反向接纳新版本写入。跨格式回退须恢复同一停写时点的双目录与配套镜像，仅换镜像不够，元数据也不能恢复已经释放的媒体。已有密码的实例须验证原密码一次后设 PIN，不重新开放无验证初始化。

## 性能边界与诊断

使用 `scripts/benchmarks` 的合成数据，记录 CPU/内存、存储、样本量、预热与测量范围。日志将数据库池等待、SQL 执行和 RPC 往返分开，不能把所有等待归因于 SQL。真实网络诊断在 `scripts/diagnostics`，需显式启用，独立于默认离线测试。

- `capture_polling` 将 `admission`、`upstream`、`persist`、`sweep`、`tail` 和 `rotation` 分开汇总。`p95UpperMs` 是固定桶的上界，先核对样本数，再用 `deadlineLimitedSweeps`、`capacityLimitedSweeps` 和 `skippedClockRuns` 判断拥塞阶段。上游超时后仍未返回的物理请求继续占用原容量。
- `workbench_batch_timing` 记录取消或耗时至少 500 ms 的批次，每 10 秒最多一条，包含请求跨度（`spanHours`）、每行桶数（`buckets`）、请求行数、准入行数、等待取消数和排空耗时。按同一请求 ID 关联 `metadata_rpc_slow`、`database_pool_wait` 和 `database_query_slow`，分别看 RPC、池等待和 SQL。等池与已发送语句仍可能延长排空。
- [录制启动基准](../scripts/benchmarks/recording-start.mjs) 测量已有新鲜 `PUBLIC` 状态时的定向启动。`statusCalls` 显示是否实际调用上游。[轮询基准](../scripts/benchmarks/capture-sweep.mjs) 用 203 个合成主播和 180 秒虚拟时间，比较快慢请求混合、观看占用及串行落库下的确认间隔、租约余量和上游调用量。
- [工作台成本基准](../scripts/benchmarks/workbench-cost.mjs) 通过真实 HTTP 路由、归档 Worker 和临时 PostgreSQL 测量空覆盖、密集覆盖和有已看记录的窗口。分别查看覆盖与状态历史的 RPC 次数、Worker 时长和表访问。命令末尾可加采样次数与跨度小时数，例如 `8 168` 测量一周。浏览器 `list-scroll` 场景默认用一周密集数据，记录缓存命中时的帧间隔、详细轨道挂载数与网格绘制高度，设 `STV_QA_SCROLL_DAYS=1` 可对照一天。
- [录制与回看混合基准](../scripts/benchmarks/recording-workbench.mjs) 在两个固定运行镜像中重放同一计划。归档层接收 21 路合成分片和 194 个目标的状态观测，回环 HTTP 发起工作台、播放、媒体读取和针对合成历史的删除。该基准测量持久化和接口，真实上游、录制调度和浏览器解码需要独立验证。
- [截图空闲基准](../scripts/benchmarks/screenshot-idle.mjs) 用 1,000 个合成主播和真实 PostgreSQL，在完成首次轮转后统计 10 秒内的目录、录像单元分页、统计与领取查询。构建后在同一 QA 容器执行 `node scripts/benchmarks/screenshot-idle.mjs`。

[运行时性能汇总](../scripts/diagnostics/runtime-performance.mjs) 从标准输入读取一段 JSONL。它输出采样时段、事件计数、各阶段观测值的最大值和按请求 ID 的关联数量，报告中只保留预先列明的诊断字段。用 `input.firstAt` 和 `input.lastAt` 确认实际覆盖范围。`highestWindowP95UpperMs` 是已收集窗口中最高的 P95 上界，跨窗口的 P95 需要原始分桶计数。

```sh
docker compose logs --since 30m --tail 20000 --no-color --no-log-prefix app 2>&1 | docker run --rm -i --network none --entrypoint node st-vault:qa scripts/diagnostics/runtime-performance.mjs
docker run --rm --network none st-vault:qa sh -ec 'npm run build && node scripts/benchmarks/recording-start.mjs && node scripts/benchmarks/capture-sweep.mjs'
docker run --rm --network none --entrypoint sh st-vault:qa -ec 'npm run build && node scripts/benchmarks/workbench-cost.mjs'
```

运行混合基准时，每版使用新的空白 `/audit-scratch`，把脚本只读挂载为 `/audit/recording-workbench.mjs`，以 `STV_BENCH_SCRATCH=/audit-scratch` 和 `node /audit/recording-workbench.mjs 1080` 启动。可将同一份合成 fMP4 目录只读挂载到 `/audit-fixture`，并设置 `STV_BENCH_FIXTURE=/audit-fixture`。目录包含 `stream.m3u8`、`init.mp4` 和 `seg<数字>.m4s`。两版串行运行，固定镜像 SHA、存储类型、资源上限及媒体文件哈希。

容器使用 `--network none`、`--restart no` 和无轮转的 `json-file` 日志。启动前准备独立的证据目录，在删除容器前分别保存实时和退出后的 stdout、stderr、Docker 事件及退出状态。PostgreSQL 将进程类型、SQLSTATE 和检查点写入原始 stderr。检查 `recording_workbench_trace_complete` 中各操作的计划数、完成数、丢弃数和分位数，并核对 `recording_workbench_deletion_results` 中后台删除的最终状态。

收集前确认运行镜像包含所需事件。慢日志受阈值和限频影响，计数只能描述收到的样本。调整轮询配置前，在相近的监控和观看负载下对比真实状态确认间隔、租约余量、上游错误及写入排队。`pollMs` 同时影响业务心跳和录制状态的有效期。

持续录制、真实上游延迟和 NAS 长期 I/O 需要独立采样。控制类录制前置读保留专用准入。密集时间线在不同渲染环境中的成本也应分别计量。
