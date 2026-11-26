# HTTP 接口参考

**简体中文** · [English](api.en.md)

这些接口服务于同仓库工作台，尚未承诺独立公共 API 的版本兼容。请求约束以 [api-schema](../packages/api-schema/src/index.ts) 和各 HTTP 模块为准。时间均为 UTC epoch 毫秒，ID 使用 `stripchat:<providerId>`。界面按 `/api/session` 返回的 `timeZone`（部署 `TZ`）显示。

除健康、静态资源和本地登录/初始化入口外，业务接口要求管理员会话。管理员可使用 `GET /api/keys/current` 查看当前密钥，使用 `PUT /api/keys/current` 提交 `{name, value}` 添加或更换。修改请求校验 Origin，敏感接口禁用缓存。HTTP 的部署边界见[安全与数据保护](SECURITY.md)。

## 会话与账户

| 方法和路径                             | 行为                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /api/session`                     | 读取管理员认证与初始化阶段                                                                                       |
| `POST /api/setup/session`              | 获取受限初始化许可；旧部署需验证原密码                                                                           |
| `POST /api/setup`                      | 提交 `{pin}` 完成初始化，不要求账户连接                                                                          |
| `POST /api/login` / `POST /api/logout` | PIN 解锁、撤销当前会话                                                                                           |
| `GET /api/account-sync`                | 账户资料和同步状态，无凭据                                                                                       |
| `PUT /api/account-sync`                | 导入 `{cookiesText, origin}`                                                                                     |
| `DELETE /api/account-sync`             | 断开并返回 `{status, draft}`；draft 为原 `{cookiesText, origin}` 或 null，供浏览器保存站点绑定草稿。响应禁止缓存 |

初始化许可只用于完成 PIN，不可访问账户、录像或设置。没有原站账号密码登录、验证码任务或直接清单导入接口；账户仅通过粘贴 Cookies 接入。实现见 [http/app.ts](../apps/server/src/http/app.ts)。

账户接口仅允许已解锁的管理员会话，返回 `Cache-Control: no-store, private`。导入未提供来源时沿用当前来源，未连接则使用默认值；登录后绑定域名，不接受不同域名的更新（409 account_origin_locked）；退出后可重新选择。网站测速也受相同连接锁约束。退出通过持久化空清单提交归档全部主播并停录，重启后继续恢复，录像保留。

## 工作台与媒体

| 接口组 | 入口与契约                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 主播   | `GET /api/subjects`；单主播/批量策略 PATCH；`PUT /api/subjects/recording-default` 保存 `{enabled}` 并应用到全部未归档主播          |
| 时间线 | `GET /api/workbench` 聚合可见行，`GET /api/archive-calendar` 返回全库空白日期。单主播接口包括 timeline、coverage、recording-bounds |
| 直播   | `POST /api/subjects/:id/live`；live-progress；会话 manifest/media；DELETE 关闭                                                     |
| 回放   | `POST /api/playback`；会话 seek、close、manifest 和授权媒体读取                                                                    |
| 图片   | preview/avatar JPEG、snapshot-pages、单元 JPEG                                                                                     |
| 历史   | events、events/meta、events/runs、events/read                                                                                      |
| 网络   | network/routes 读取/更新 HLS CDN；network/probe 手动测试 CDN 或登录候选站点                                                        |
| 管理   | system、settings、keys、me/favorites                                                                                               |

`GET /api/subjects` 在有连续在线记录时返回可选的 `onlineSinceMs`，表示工作台用于在线排序的、最近一次连续在线的最早观测时间。连续的公开和私密状态属于同一次在线。`lastOnlineAtMs` 仍是最新在线状态区间的起点，供离线和归档排序。

`GET /api/archive-calendar` 返回 `{emptyDays:[{fromMs,toMs}]}`。范围按时间排序，覆盖部署时区里已结束且全库没有可回放录像的完整日期，相邻空白日合并为半开区间。该接口要求管理员会话并禁止缓存。工作台和运行记录允许最多八个 UTC 日的可见时长，录像定位、回放、截图分页与批量操作允许最多九个。超过原始时长上限的请求由服务端用全库空白日期验证可见时长。原始分片列表和单主播独立状态、覆盖接口仍使用各自的原始时间范围上限。

`GET /api/network/routes` 返回可选节点 `cdnHosts`、已选节点 `preferences.cdnHost`、生产者已解析的节点 `activeCdns` 和手动测速状态 `cdnProbe`。保存不同节点后，各直播生产者立即取消旧节点请求并连接新节点。

`POST /api/network/probe` 接受 `{kind: "cdn", subjectId?: string}` 或 `{kind: "sites"}`，返回 202 后可通过统一刷新读取进度。CDN 测速可在未播放时运行。`sites` 仅在账户未连接且无同步任务时可用。绑定站点的实际访问状态由 `sites.access` 独立报告。

直播会话绑定管理员拥有者，回放读取受会话、范围及逻辑删除约束。图片按版本缓存；截图待生成时返回 202，不应解释为永久缺失。

`POST /api/playback` 的 `gapPolicy` 支持 report、next、previous 和 next-or-previous。删除后重建使用 next-or-previous：先根据现存完整单元收缩指定范围，在范围内优先后续画面，游标超出剩余尾部时定位到最后可用时刻；没有后续画面时允许前一段。指定 unitId 的读取仍严格按单元身份定位，不替换为其他单元。固定范围为空返回409 coverage_gap，客户端直接呈现原选区为空，不再查范围外的边界。普通 next 请求仍不回退，防止录像续播在末尾循环。

`GET /api/subjects/:id/snapshot-pages` 使用 `at`、`from`、`to`、`page`、`limit` 查询，`limit` 上限1000（界面固定30格），可选 `unitId` 返回精确的 `playbackUnitPage`；`follow=1` 表示直播尾部跟随，`page=last` 直接读取最后一页。响应的 `items` 是录像单元，`total` 是实际展示范围内可见的单元数，不要求 JPEG 已生成。`cells` 给出 `unit`、`gap` 或 `pending` 格位，`slotCount` 是压缩后的总格数，`pageOffset` 是本页起始格位；空档不计入总张数，也不能被喜欢或删除。小于一分钟空档不占格，一至两分钟一格、两至三分钟两格、更长最多三格，不生成全空页。`pages` 对应本次 `limit`，`occupiedPages` 和 `pageAnchors` 提供30格导航及时间定位，不能再用经过的分钟数推算页码。直播从尾部最多保留30格，去除起始空档，并将 `displayWindow.fromMs` 和 `session.selectionFromMs` 对齐到首个保留完整单元的起点；`displayWindow.toMs` 保留请求右边界。客户端展示与批量选择使用实际范围，不选中窗口外单元；回放仍保留整个请求范围的分页。普通与全屏共用相同直播边界、单元身份与30格分页读取，滚轮只切换当前页，不加载历史前缀。

响应必带 `deletionRevision`，直接使用该主播删除世代，覆盖删除接受和保留清理墓碑，不随普通录制分片增长。客户端不能混合不同删除世代的展示块；观测到较新世代后淘汰旧缓存，拒绝迟到旧包。并发删除可能使正在准备或读取的截图布局失效。服务端在同一请求时限内从当前归档状态重建。归档繁忙返回 503，截图查询超时返回 504。范围操作与有界展示缓存分离。“取消所有喜欢”使用服务端冻结范围令牌；“删除所有非喜欢”直接提交持久范围意图。两者覆盖整个当前时间范围而非当前页，浏览器不下载完整目录、不维护多选成员；个人revision和删除世代过时返回409，不暗中重建令牌扩大操作范围。

实现入口：[直播](../apps/server/src/http/live.ts)、[图片](../apps/server/src/http/previews.ts)、[工作台](../apps/server/src/http/workbench.ts)、[历史](../apps/server/src/http/events.ts)、[网络](../apps/server/src/http/network-routing.ts)。

截图的 `unitId` 是完整源分片成员集合的稳定身份，`slotFromMs` / `slotToMs` 是该单元真实完整范围，`open` 表示尚可增长，`atMs` 是稳定的代表取样锚点。一个源分片即使跨过自然分钟也不拆分；视窗只决定哪些单元相交，不改写它们的边界。JPEG URL 的 `to` 是稳定解码搜索上限，实际解码仍限制在对应单元内；追加分片不反复换URL或重采样。`gridIndex` 是服务端布局位置，不能从 `atMs / 60000` 反算。

`recording-bounds` 把拖动选区向外吸附到首尾相交完整单元。直播当前时刻、实际播放游标和已落盘末端分离；开放单元回放的 `openUnitId` 用于继续等待同一单元的新成员，不把之后无关录像自动纳入已选范围。

覆盖桶在有媒体时附带 `mediaFromMs` / `mediaToMs`，表示桶内实际有画面的最早、最晚时间；空桶不带这两个字段。它们复用分钟覆盖索引与逻辑删除投影，供覆盖绘制和滑选即时反馈共用，不增加持久格式。桶内可能仍有碎片空隙，选区最终通过 `recording-bounds` 精确核验，不能用桶的首尾推断其内部全部连续。

删除任务接纳时一次发布录像可见性的变更。后台分批整理与清除已经隐藏的分片只更新任务进度。删除影响当前区间时，工作台通过同一个 `recording-bounds` 接口重新吸附原区间。剩余录像继续在该区间内播放，空区间使播放器和截图区恢复初始状态。

有收藏画面时，覆盖响应还包含 `favoriteSpans`。它根据已接纳的收藏和单元内仍可播放的分片生成。跨大范围时按显示桶限制数量。工作台和播放器优先用粉色绘制这部分覆盖，已读进度仍独立保存，取消收藏后恢复已读或未读颜色。

悬浮预览使用 GET /api/subjects/:id/snapshot-point?at=<毫秒>，只返回一个单元或null；旧的全范围snapshots列表接口已移除。回放创建可带unitId，在相同PDT的多个单元中精确定位；显式单元不存在时拒绝，不退回猜测时间归属。普通录像覆盖读取不计算或返回 protectedSpans。只有未发布删除可见性版本的非喜欢删除任务，才通过工作台 protection 主播 ID 参数按需请求有界保护摘要；与 seenSpans 在同一读取快照返回，可复用按媒体版本与收藏版本区分的缓存。点击删除立即复用截图区已加载的收藏范围，无需等待该查询；任务发布版本或失败、结束后停止请求。服务端删除仍独立核验完整收藏关系，前端摘要不决定删除许可。不绘制独立喜欢标记，也不作为编辑边界。

## 后台运行状态

`GET /api/sync` 使用 SSE。建立本连接的初始同步基线后，服务端发送 `ready`。后续 `change` 提供需要重新读取的 `topics`，`clock` 提供服务端时间和当前间隔。重连后客户端按当前视图重新读取数据。

当时间线只因同状态观测续期而变化时，`change` 可附带 `timelineSubjectIds`，最多 64 个主播 ID。范围只作用于本条消息的 `timeline` 主题。缺少该字段时刷新整个主题。媒体版本变化、确认状态切换和主播集合变化仍使用全局通知。

`GET /api/system` 保留原有健康、磁盘、录制和截图数据，并返回 `capturedAtMs`、`backgroundTasks` 与 `ingress`。任务项包含稳定 `id`、分组 `group`、状态 `state`，以及可选的最近执行/成功/下次调度时间、已处理量、总量、待处理量和失败量。没有总量时不能由客户端推算百分比。`target` 仅用于公开接入点的主机名及延迟，不包含凭据、媒体地址或本地路径。`ingress` 是共享直播入口的当前主播数、保留字节与内存预算。

`deletionJobs` 与 `GET /api/media-deletions` 返回的任务列表格式相同，包含所有已获名额的在途任务、最多 20 项最早等待名额的任务和最多 20 项最新终态任务。`deletionWaiting` 为等待名额的完整数量。空数组表示没有任务，`null` 表示状态暂时不可用。客户端可用独立接口恢复读取，或在删除提交的响应丢失时按命令 ID 立即核验。

状态读取不启动任务，不扫描整个录像或截图历史。某个观测源失败时保留其他源的结果，该任务以 `task_status_unavailable` 标记；同一失败周期只记录一次诊断及一次恢复事件。浏览器复用统一时钟和 SSE 失效更新，不为状态面板建立额外轮询。具体任务见[后台任务参考](architecture.md#并行与任务调度)。

## 批量喜欢与删除

`GET /api/media-deletions/:commandId` 按 UUID 查询单条删除回执，需要登录。返回当前任务或已从近期列表裁剪的终态任务，响应结构均为 `MediaDeletionJob`。无可用回执时返回 404 和 `media_deletion_not_found`，读取失败时返回服务错误。查询本身不发起删除。升级前已丢失的历史回执也可能返回 404。

`POST /api/subjects/:id/unit-seen` 接收 `{evidence:[{unitId,toMs}]}`（1–100 项），将该主播可见单元的 `seen_to` 单调推进到已展示边界，并截断至已提交媒体终点，返回 `{changed}`。截图加载成功且首次进入前台截图区的可视范围时，记录界面当时已知的落盘末端。预取和悬浮预览不产生已看记录。已经展示的图片不会因单元增长、封口或元数据刷新而自动追加已看范围，旧请求不能回退边界。`unit_seen_ranges` 经媒体库持久日志保存，不修改喜欢 revision，不参与保留保护。覆盖响应的 `seenSpans` 汇总已看前缀。有已看证据时还返回 `unreadSpans`，汇总未看后缀；空数组表示窗口内没有未看的录像覆盖。两种投影均按桶限制数量，同一桶可以同时包含已看和未看区间。时间线分别绘制两种覆盖，空档保持空白。这些投影仅供显示。客户端使用独立 `seen` 通知刷新时间线，避免重载截图目录；其他客户端沿统一心跳读取。

网页删除统一使用 `POST /api/subjects/:id/deletion-intents`，提交 `{commandId,target}`。`commandId` 为 UUID；target 共同包含 `fromMs,toMs`，并按 kind 指定 `units + unitIds`、`selection + selectionId/patch` 或 `range + mode(all/unliked)/baseSelectionId/patch`。202 表示意图已写入媒体库日志，准备和删除均由后台接手，逻辑隐藏即刻生效。相同键与同一目标返回原任务；不同目标复用键返回409。`GET /api/media-deletions` 同步 waiting/preparing/queued/running/retry/completed/failed、phase、scannedUnits、selectedUnits和删除版本，等待与准备阶段可以没有已知总量。见[持久命令](architecture.md#录像单元与前端一致性)。

归档为准备和回收保留 64 个在途名额。名额用完时，已确认的请求仍持久入队，返回 202 和 `waiting` 状态。名额释放后按入队顺序自动补位，进程重启后继续处理原任务。遇到归档读取繁忙时，同一任务会退避重试。

`phase=plan` 时，已持久化的清单页可以先回收，`total` 会随清单生成而增加，`processed` 和 `reclaimedBytes` 也可同时推进。已同步确认移除的对象按归档登记字节计入一次，其中包含重启前已移除而尚未确认的对象。任务在清单结束且全部批次确认回收后进入 `completed`。

以下精确集合与计划接口仍可用于程序化检查；网页不再等待其预览或统计：

1. `POST /api/subjects/:id/media-selection`：提交 `{fromMs,toMs,mode}`，mode为 `all`、`unliked` 或 `explicit`；可带baseSelectionId进行并集，及includeUnitIds/excludeUnitIds。后台每批256单元准备冻结集合，返回id、count、personalRevision和deletionRevision。准备取消不会提交修改。
2. `POST /api/subjects/:id/media-selection/:selectionId/favorites` 接收 `{liked,revision}` 和可选增删例外。`liked` 接受布尔值或 `"toggle"`。翻转操作按同一版本确定收藏和取消收藏的两组单元，并在一个事务中接纳。接纳后逻辑收藏即时生效，物理标记每批 256 项整理，重启后继续。每个非空组推进一次 `revision`，`count` 和旧 `removed` 字段报告目标数。
3. `POST /api/subjects/:id/delete-selection/preview`：提交selectionId或unitIds，两者互斥；冻结完整单元身份，返回影响范围、计划和个人revision；旧ranges HTTP输入明确拒绝。大集合准备也分批让行。
4. `POST /api/subjects/:id/delete-selection`：提交 `{planId,personalRevision}`，202表示已接纳。逻辑隐藏立即生效，回收后台分批执行；`GET /api/media-deletions`读取进度和重试状态。
5. 明确单元 ID 的操作使用 `POST /api/subjects/:id/unit-favorites/query` 或 `POST /api/subjects/:id/unit-favorites`。写入端点接受 `{unitIds,liked,revision}`，其中 `liked` 同样接受布尔值或 `"toggle"`。`DELETE /api/me/favorites/:id` 也使用同一套收藏命令和逻辑投影。

接受和保留清理在同主播写序列中协调；已接纳喜欢在物理整理之前就保护整个单元，包括后续追加成员。取消喜欢后重新适用保留规则，不立即删除录像。明确确认的手动删除仍可删除喜欢画面；逻辑已删除单元不继续出现在个人喜欢和覆盖摘要中。其他客户端改变个人revision或删除世代时返回409，必须重新确认，不能默默扩大原操作。

显式ID数组最多100000，作为HTTP载荷保护；服务端冻结选择不要求把整个选区编码为该数组。主体选择范围最多9天，以容纳界面7天视窗向完整单元外扩。确认删除时补入开放单元最新成员并封闭目标，后继新录像不进入旧计划。已接纳操作独立于浏览器继续；关闭页面不回滚持久意图。

实现：[媒体选择](../apps/server/src/http/media-selection.ts)、[选择存储](../apps/server/src/archive/media-selection-store.ts)、[喜欢命令](../apps/server/src/archive/favorite-commands.ts)、[删除](../apps/server/src/archive/deletion-store.ts)。

## 错误与取消

`POST /api/system/retry` 接受 `{target}`，对应一个事项，例如 `cover-sync`、`disk-check` 或 `deletion`。`GET /api/system` 的 `retryableTargets` 列出当前可以独立执行的恢复动作。提交成功返回 202 和执行状态，事项已恢复或需外部处理时返回 409 `system_retry_not_applicable`。同一事项正在运行或在 5 秒内重复提交时返回已有尝试，不同事项分别处理。`retries` 和同步通知提供运行进度，恢复结果由该事项的诊断确认。录像删除重试先确认存储状态，再按后台并发上限唤醒一批已确认的删除任务。任务失败后会重新进入退避。

业务错误返回稳定错误码，由前端统一翻译。401 为会话失效，参数错误不应无限重试；429 按响应限流信息处理。网络/服务错误按各自任务边界有界重试。请求取消不能回滚已经持久接纳的删除任务。

较重元数据读取达到准入上限时，返回 503 `{error: 'archive_busy'}` 与 `Retry-After: 1`。客户端应保留已有内容并按提示有界重试；未向 worker 发送的读取可以拒绝，已接纳写入不会因该保护超时或取消。

`GET /api/workbench` 断开时会停止派发后续行和后继只读 SQL。已提交的语句和连接池等待仍须结算，之后才归还事务容量。批次中的元数据忙错误仍按 503 和 `Retry-After` 返回。

修改接口时同步更新 schema、服务端、客户端和边界测试；不要让某个错误被解释为虚假的离线状态、无录像或成功删除。

浏览器统一将读取请求限定为 15 秒、修改提交限定为 30 秒。修改请求遇到传输失败或无法确认结果的服务错误时，不自动重放，也不把客户端超时解释为服务端回滚；先释放交互锁，再限时回读当前事实。截图喜欢按单元ID回读，删除通过已提交计划ID观察持久任务；未查到结果仍表示未知，不表示确定未执行。明确拒绝准入的 archive_busy 返回503，由界面提示稍后再试。

单张喜欢的单元保护查询有15秒准备预算；切换选区或卸载时取消准备，迟到读取不能继续提交。准备失败表示尚未提交写入；已提交POST独立使用修改预算，不继承准备阶段的取消信号，也不自动重放。

可重建播放会话通过请求选项 operation=session 显式保留原始传输/服务错误，沿用播放器已有的有界预备重试；该选项不会发送给服务器。会话请求中止与响应未完成时服务端负责回收，另有会话 TTL 和数量保护。持久收藏/删除不使用此策略，未知结果不会进入会话重试。
