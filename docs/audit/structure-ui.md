# 模块结构与浏览器工作台审查

2026-11-24 至 25 日，D2、D6 与附录 A1、A3。前端版本 `db4a143b3` 的可解析运行时导入环和含类型环均为零。最大生产 UI 源文件 App.tsx 为 1,181 行。PIN 冷启动五项子资源响应体在整轮审查前为 2,676,103 字节，资源优化前为 2,676,411 字节，优化当时为 666,368 字节，加入启动重试与键盘取段后为 667,989 字节，修复 WebKit 触摸后为 668,005 字节，稳定选区工具位置后最终实测为 668,320 字节。大图缩小及移出首包的 Zod 贡献了主要差值。历史首读、轨道焦点、许可证、初始连接重试和键盘创建选区均有独立的改动前失败、改动后通过证据。[主报告](REPORT.md)

基于最终代码 `5b31ca6a9` 再次遍历完整 Git 文件清单和 TypeScript AST，612 个文件、551 个 JS/TS/CSS 模块、39 个长文件、172 个超长函数或回调，以及运行时和含类型环数 0 均已复核。B33 改动截图输入控制器和其测试。两份源文件分别为 476 和 431 行，新增用例未超过长函数阈值。B34 与 B35 改动正式截图手势场景，覆盖双向翻页及跨页收藏工具栏。B35 时该场景为 429 行，B37 的可信输入及页码验证使最终场景为 448 行。B36 调整选区操作的排列与布局，以下包体及首屏使用 B36 正式镜像。

## D2 · 模块边界与规模

按 `5b31ca6a9` 的 Git 树清单导出源码，排除依赖安装、媒体、运行数据和本次审查报告。复扫快照含 612 个文件，其中有 551 个 TS、TSX、JS、MJS、CJS 或 CSS 模块，其中 243 个位于生产源码，含服务器 113 个、UI 126 个、契约包 4 个。逐文件统计文本物理行，逐函数统计含注释、嵌套回调、空行的定义跨度。大于 500 行的文本文件有 39 个，其中生产 TS/TSX 有 14 个。大于 80 行的函数或回调有 172 个，其中生产源码有 115 个。嵌套项不能相加。Shell 与 PowerShell 另核对，无超过 80 行的函数。扫描包括两份 FFmpeg 补丁、录制时间窗辅助模块，以及新增的浏览器拦截器排空回归与辅助模块。这些文件均未超过列出的行数阈值。详见[逐文件、逐函数判断](structure-inventory.md)。

### 导入图

按本仓锁定的 TypeScript AST 解析 import、命名再导出、import type、类型表达式 import()、传入字面量或 new URL 分支内含本地路径的动态 import()、CSS 引入和 Worker URL。按 TS 配置保留有运行时副作用的空具名导入，将 Worker 视为独立入口。应用与包内部的相对路径解析包含输出 .js 对应源码 .ts、扩展名省略、index 入口及工作区包导出。对强连通分量枚举简单环，不重复报告起点旋转。记录到 1,065 条静态 import 边、4 条运行时再导出边、449 条类型边、27 条可解动态边和 2 条 Worker 边。一个 import 声明可产生多种边。工具及测试另有 10 个动态路径表达式，含外部传入的构建目录，模块图没有推测这些目录的内容。完整边及未解析表达式位于本机复核材料 `.local/audit-closure/gesture-target/measurement/structure.json`。[编译选项](../../tsconfig.base.json#L1) · [动态加载夹具](../../tests/e2e/support/fixture.mjs#L7) · [维护脚本](../../scripts/maintenance/migrate-library.mjs#L6)

| 批次           | 原始依赖与修复                                                                                                                                                                                                                                                                                                     | 验证                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| D2-01 · 已修复 | 契约 index 导出录制布局，布局同时从 index 引入 MediaTimeRange、SnapshotCell 两个仅含原始字段的接口。现由录制布局定义，原包根入口继续导出。涉及两个文件。[布局契约](../../packages/api-schema/src/recording-layout.ts#L1) · [包根出口](../../packages/api-schema/src/index.ts#L11)                                  | 容器图断言从失败到通过，含类型环由 2 降到 1；契约单测 7/7。                                                         |
| D2-02 · 已修复 | Player 使用 MediaSlot，MediaSlot 同时从 Player 引入 PlayerSource。现由持有 sourceKey、closeSource 的 MediaSlot 定义两种播放来源，Player 保留原路径的两个类型出口。涉及两个文件。[类型所有者](../../apps/ui/src/features/player/MediaSlot.tsx#L12) · [原路径出口](../../apps/ui/src/features/player/Player.tsx#L36) | 第二项图断言从失败到通过，剩余环由 1 降到 0。Player/MediaSlot 单测 50/50。                                          |
| 最终结果       | 可解析的运行时导入环 0，包含类型边的环 0。工具或测试的动态构建目录仍按上文列出的边界处理。                                                                                                                                                                                                                         | 三个工作区类型检查通过，四个原路径类型通过兼容编译。仅在两个类型移动批次的前后，128 个发布文件的 SHA-256 逐项相同。 |

完成这两个类型归属批次时，发布文件按相对路径排序后的 SHA-256 清单，前后摘要均为 `f84d77ea2490208ad34cdd4aa4aeb301e058d234e1bc0abd3f2e130e582c2eb6`，覆盖浏览器 JS/CSS、许可、图像、服务端与契约 JS。后续新增的会话重试与键盘取段改变了发布 JS，最终字节见 D6。每个类型批次都可独立撤销其两个文件。原始结构断言、编译和构建对照在 `.local/audit-closure/frontend/cycle-*.log`。

### 公共边界、入口与复制

- 根目录分为 apps/server、apps/ui、packages/api-schema、scripts、tests、deploy、docs。服务器按 archive、database、http、previews 等职责分，UI 主要按 features、shared、design 分。跨层规则禁止 UI 直接导入服务器及库代码反向依赖 UI 功能。UI 取数通过 HTTP，公开包的 exports 仅提供根路径。生产源码有 9 个从其他模块命名再导出的语句，没有 export-star。面向浏览器和服务器共用契约时根导出兼有运行时代码，其中五个验证器现已独立，效果见 D6-02。[仓库边界检查](../../scripts/check-repository.mjs#L51) · [包导出](../../packages/api-schema/package.json#L6) · [契约入口](../../packages/api-schema/src/index.ts#L1)
- 文件夹命名通常是 kebab-case，UI 组件 PascalCase、其余模块 kebab-case。例外为同名 network-routing，HTTP 层装配请求，network 层维护状态，各有明确所有者。功能域之间存在可见耦合，时间线从 player 再导出 RowAnchor 类型，历史面板从 timeline 取时间格式、从 directory 取封面；它们属于 UI 内部入口，没有越过工作区的公开包边界。所有者归属变更时应检查这三处。[时间线出口](../../apps/ui/src/features/timeline/TrackBoard.tsx#L51) · [历史依赖](../../apps/ui/src/features/history/HistoryPanel.tsx#L6) · [网络 API](../../apps/server/src/http/network-routing.ts#L1) · [网络状态](../../apps/server/src/network/network-routing.ts#L1)
- 对生产模块找不到生产入边的 4 个文件逐一验证。HTML 引入 UI main，容器启动 server deploy/start，start 通过子进程启动 deploy/application，旧库迁移由维护 CLI 按已构建路径加载。没有据此可删除的孤儿生产模块。最常被其他生产模块直接运行时引用的是 UI i18n（48）、UI request（24）、server provider/http（23）。公共导出、反射、动态路径和同义不同写法不能凭这个检查宣告死代码。[HTML 入口](../../apps/ui/index.html#L12) · [容器启动](../../deploy/Dockerfile#L83) · [子进程](../../apps/server/src/deploy/start.ts#L69) · [迁移入口](../../scripts/maintenance/migrate-library.mjs#L6)
- 对生产具名函数/方法去空白及注释、比较长度至少 60 个字符的相同实现体，检出 1 对相同体，均为集合订阅与退订，分别归属网络偏好和站点路由。没有三份相同实现体；该检查不覆盖短方法、匿名回调或语义近似代码。TypeScript 的 noUnusedLocals/Parameters 与编译配合检验局部符号，公开导出的语义可达性仍需调用方审查。[网络订阅](../../apps/server/src/network/network-routing.ts#L45) · [站点订阅](../../apps/server/src/provider/site-routes.ts#L118) · [编译约束](../../tsconfig.base.json#L12)
- “新增同类功能 ≤3 处”对该仓没有普遍保证。例如新增同步域会涉及共享契约、服务器发布者、UI 订阅和对应验证。已有域的展示调整通常可局限于功能文件与测试。HTTP 装配包含部分具体端点，元数据 Worker 同时派发事务、读写索引；UI 仍有多个跨域协调组件。不能用通过边界检查代替职责判断。[同步契约](../../packages/api-schema/src/sync.ts#L1) · [UI 订阅](../../apps/ui/src/shared/lib/sync.ts#L1) · [HTTP 装配](../../apps/server/src/http/app.ts#L1) · [元数据 Worker](../../apps/server/src/archive/metadata-worker.ts#L1)

## D6 · 首屏与包体

以 `db4a143b3` 的正式 QA 镜像内发布文件为准，再用隐藏 source map 构建一遍，同名 JS 逐字节一致。沿生成代码每个映射段计算压缩后源文件中的 UTF-8 字节，汇总到对应 npm 包。这里的“压缩”指构建器消除空白、压缩标识符；gzip 另行按整个产物测量，不能把单个库的原始映射量当网络压缩量。未映射字节保留为未知。另取构建器每个 chunk 的实际 rendered modules 独立交叉核对。正常发布输出中没有 .map。两个入口文件的 SHA-256 及 CSS、图像、许可证和 HTML 的哈希均保存在 `gesture-target/measurement/runtime-assets.log`，7 个文件与正式运行镜像逐字节一致。[Vite 配置](../../apps/ui/vite.config.ts#L1) · [构建入口](../../apps/ui/package.json#L1)

| 排名 | 实际运行时依赖          | 映射字节 | 下载阶段             |
| ---: | ----------------------- | -------: | -------------------- |
|    1 | hls.js                  |  577,459 | 使用播放器引擎时按需 |
|    2 | react-dom               |  129,125 | 首屏                 |
|    3 | i18next                 |   49,630 | 首屏                 |
|    4 | react                   |    6,984 | 首屏                 |
|    5 | react-i18next           |    5,153 | 首屏                 |
|    6 | scheduler               |    3,785 | 首屏                 |
|    7 | @date-fns/tz            |    3,504 | 首屏                 |
|    8 | @st-vault/api-schema    |    1,097 | 首屏，本仓工作区依赖 |
|    9 | use-sync-external-store |      725 | 首屏                 |

最终外部 npm 包只有 8 个，加上工作区包共 9 个可排名依赖。Zod 在改动前的十项排名中为第三（83,467 字节），最终构建贡献为 0。应用 UI 自身 253,842 字节，入口未映射 54,059 字节，HLS 未映射 1,655 字节。主 JS 对应 140 个映射来源，HLS 对应 1 个，交集 0。构建器在主 chunk 记下 156 个模块标识，HLS chunk 仅有 hls.js/dist/hls.mjs，未发现 React、调度器、HLS 跨两包重复打入。两种计数分别统计 source map 来源和构建模块标识。校验数据见 `.local/audit-closure/gesture-target/measurement/bundle.json`、`rendered.json`。

| 最终发布产物         | 原始字节 | 本地 gzip 字节 |
| -------------------- | -------: | -------------: |
| 初始 JS              |  507,904 |        168,370 |
| 初始 CSS             |   79,592 |         16,623 |
| 按需 HLS JS          |  579,114 |        179,042 |
| 主品牌 PNG           |   72,414 |         72,398 |
| Favicon PNG          |    8,295 |          8,318 |
| 按需查看的许可证清单 |    9,258 |          1,465 |

**D6-01 · P2 · 已修复，品牌图在冷启动传输两次。** 旧 PIN 页实测同一 PNG 的 other 与 img 两条资源记录，encodedBodySize 均为 1,002,639，各自 transferSize 为 1,002,939。原图 RGBA 宽高 1,160，页面展示宽约 36 CSS 像素，README 使用 88 像素。保留同字节原稿，现用 Lanczos 等比生成 264×264（最大展示的 3 倍）及 64×64 favicon。真实 Chromium 同场景两条 PNG 响应体分别为 72,414 与 8,295，合计减少 1,924,569 字节（95.98%）；两版的布局宽度均约 36。浏览器回归在旧实现得到 1160 ≠ 264，现验证两张图分辨率、正方形比例及完全透明/不透明像素均存在，并跑完双语布局场景。回滚范围为原稿、两个生产 PNG、HTML 入口与浏览器用例。[原稿](../assets/st-vault-mark-original.png) · [图标声明](../../apps/ui/index.html#L7) · [登录页品牌](../../apps/ui/src/features/auth/AuthGate.tsx#L289) · [回归](../../tests/e2e/localization-layout.mjs#L24)

**D6-02 · P2 · 已修复，服务端的 Zod 进入 PIN 首屏。** UI 从契约根入口取同步域、运行时常量和录制布局，旧根模块同时构造 Zod schema。仅将验证器移到新模块的隔离构建仍包含 Zod。核对全部生产契约文件，其模块初始化仅创建契约值并导出，没有需由浏览器保留的外部注册或 I/O。将五个验证器移至 validation.ts 并声明此包 sideEffects 为 false，保留原根导出与所有调用点。该优化批次当时的发布入口由 591,709 减至 506,235 字节（−85,474，gzip −25,665）。锁文件仍保留 Zod，服务端校验继续执行。构建守卫旧实现失败，修复后通过；契约 7/7、HTTP 越界 ID 拒绝用例 1/1、契约与 UI 类型检查通过。若未来在契约包加入真正的全局初始化，须改为显式调用或更新 sideEffects 声明。独立回滚根入口、验证模块、包元数据与构建测试即可。[根导出](../../packages/api-schema/src/index.ts#L1) · [验证模块](../../packages/api-schema/src/validation.ts#L1) · [包元数据](../../packages/api-schema/package.json#L6) · [构建回归](../../scripts/build-release.test.mjs#L23) · [HTTP 验收](../../apps/server/src/http/app.test.ts#L570)

**加载路径。** HTML 装载单 React 根，App 根据会话显示 PIN 或工作台。设置、历史与播放器组件来自主模块，媒体引擎按需加载。新浏览器上下文进入 localhost 合成实例，PIN 首屏在录制资源中只有 JS 507,904 B、CSS 79,592 B、会话 JSON 115 B、favicon 8,295 B、品牌图 72,414 B，HLS 没有请求。五项 encodedBodySize 合计 668,320 B，Resource Timing 的 transferSize 合计 669,820 B，另有 HTML 文档 537 B。首绘 108 ms、FCP 388 ms，PIN 可聚焦且能完成设置进入工作台。每次版本测量仅一个本地样本，生产延迟、缓存与压缩由部署决定。项目没有客户端路由跳转，浏览器使用 createRoot，未启用 SSR 或 hydration。原始记录在 `.local/audit-closure/gesture-target/measurement/screen.json`。[挂载](../../apps/ui/src/main.tsx#L39) · [会话入口](../../apps/ui/src/App.tsx#L118) · [按需引擎](../../apps/ui/src/features/player/player-engine.ts#L5)

## 组件、读写状态与渲染

App.tsx 横跨会话、目录、播放器状态和工具面板组装；TrackBoard 管理虚拟行、滚动恢复、选区和展示；Player 管理双媒体槽、键盘和控件。已有独立的 useSession、useSnapshotView、播放状态与时间线模型，后续拆分宜围绕状态所有权，保留稳定的 commandId、作用域及播放来源。服务器是持久状态的权威来源；浏览器的选区、面板开关、媒体切换和命令投影是本地交互状态。截图删除需在命令回执确认后收敛，近期清单缺项本身无法证明请求失败。工作台未全面满足“无巨型组件”和“仅一处分配状态”。[App](../../apps/ui/src/App.tsx#L36) · [TrackBoard](../../apps/ui/src/features/timeline/TrackBoard.tsx#L349) · [Player](../../apps/ui/src/features/player/Player.tsx#L1) · [截图命令所有者](../../apps/ui/src/features/snapshots/SnapshotGrid.tsx#L175)

| 用户路径 | 加载、错误、空、成功与并发处理                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 历史事件 | 首读 null 显示忙碌，失败给出错误，成功空数组显示暂无，非空按事件 ID 合并。向前按 100 条补页，保留最多 500 条；读取中止和反向翻页均有合并保护。浏览器控制第一条读请求的交付并模拟游标，验证占位到空态及后续多页含义。[历史读取](../../apps/ui/src/features/history/HistoryPanel.tsx#L209) · [四态](../../apps/ui/src/features/history/HistoryPanel.tsx#L286) · [浏览器场景](../../tests/e2e/history-follow.mjs#L41)                                         |
| 截图页   | 区分等待、失败/离线、无截图和成功网格；页码、主体、视图范围及单元 ID 参与读结果判定。空槽、断档和真实截图分别渲染。分页或直播变化时仍要保留跨页选区与非幂等命令的生命周期。[空态判断](../../apps/ui/src/features/snapshots/snapshot-status.ts#L1) · [读缓存作用域](../../apps/ui/src/features/snapshots/use-snapshot-view.ts#L135) · [呈现](../../apps/ui/src/features/snapshots/SnapshotGrid.tsx#L529)                                                    |
| 轨道行   | 可见行区分加载、失败、数据就绪；未进入视口/快速滚动的行是 idle；查询成功的空轨是正常可选择的时间面。滚动期间避免立即取所有行。按 subject.id 定位缓存与 React key。[行状态](../../apps/ui/src/features/timeline/TrackBoard.tsx#L315) · [虚拟窗口](../../apps/ui/src/features/timeline/TrackBoard.tsx#L938)                                                                                                                                                  |
| 密钥管理 | 首读忙碌、读取错误、成功无密钥提示、成功持有密钥有独立状态；读取结束后安排下次轮询，写期间禁止旧轮询覆盖，离开面板中止请求。[轮询所有者](../../apps/ui/src/features/keys/KeyTools.tsx#L35) · [反馈](../../apps/ui/src/features/keys/KeyTools.tsx#L103)                                                                                                                                                                                                     |
| 初始会话 | GET 有超时与有限自动重试。初读期间显示状态，失败显示告警和“重新连接”，重试以新 AbortController 查询。成功后按会话状态进入 PIN 或已认证工作台。退出结果待确认的标签仍锁定并单独重试退出。Chromium 中断首读后恢复网络，同一文档 timeOrigin 内返回 PIN，刷新后的待确认退出也保持隔离。[读取所有者](../../apps/ui/src/features/auth/use-session.ts#L28) · [错误与重试](../../apps/ui/src/App.tsx#L118) · [浏览器回归](../../tests/e2e/logout-recovery.mjs#L15) |

1440×900 的 Chromium 登录 300 名主播的合成实例后，当前筛选的轨道滚动面高 16,200 px、视口高 762 px、每行 72 px。顶部挂载 18 行，其中 11 行可见。滚至中段并完成当前行读取后仍挂载 18 行，其中 12 行可见。两个窗口内的 subjectId 各自唯一，首个挂载主体已经变化。原始 DOM 样本在 `.local/audit-closure/gesture-target/measurement/render-window.json`。React.memo 包装 TrackRow，翻译上下文更新仍会重绘可见行。真实媒体项按 unitId 建键，固定占位和六个 PIN 装饰格按位置建键。这些观察覆盖虚拟挂载与身份，全应用 React 提交次数未做 profiler 采样。[行订阅](../../apps/ui/src/features/timeline/TrackBoard.tsx#L273) · [虚拟窗口验收](../../tests/e2e/workbench.mjs#L650) · [媒体键](../../apps/ui/src/features/snapshots/SnapshotGrid.tsx#L619) · [占位键](../../apps/ui/src/features/snapshots/SnapshotGrid.tsx#L577)

## 主题、键盘与断点

全局样式、液态玻璃、面板、播放器覆盖样式依次引入，使用 CSS 设计 token。媒体层和时间线还各自引入功能 CSS；单元尺寸、虚拟占位高度等依赖运行时测量的值采用内联样式。全局样式超过 2,200 行，后来的规则可以改变多个功能域的结果，适合按现存功能边界逐批迁移并跑视觉与交互验收。[样式入口](../../apps/ui/src/main.tsx#L7) · [设计 token](../../apps/ui/src/design/tokens.css#L1) · [虚拟高度](../../apps/ui/src/features/timeline/TrackBoard.tsx#L935)

真实 Chromium 通过 Tab 到达表单、日期、筛选、轨道和滑块。聚焦的轨道在相邻固定标签显示 3×18 px 指示条。从无选区的轨道按 Enter 进入双手柄编辑，Tab 切换起止，方向键调整一秒，Shift 加方向键调整一分钟，Page Up / Down 调整一小时，Home / End 跳到当前手柄可达边界。Enter 交由现有录像边界接口确认，Escape 丢弃并回到轨道。实测覆盖长按 Enter 不自提交、起止调整、空段保留先前录像选区及同页截图键盘操作。没有运行屏幕阅读器或触屏设备的辅助输入。[轨道入口](../../apps/ui/src/features/timeline/TrackBoard.tsx#L824) · [手柄键位](../../apps/ui/src/features/timeline/TrackBoard.tsx#L193) · [焦点指示](../../apps/ui/src/features/timeline/timeline.css#L60) · [键盘浏览器回归](../../tests/e2e/timeline-preview.mjs#L100) · [W3C 双手柄滑块](https://www.w3.org/WAI/ARIA/apg/patterns/slider-multithumb/)

对正常、系统浅色偏好、提高对比及 forced-colors 模式读取实际 computed style。应用在常规浅/深首选项下均采用深色设计；提高对比时覆盖 muted 等 token；强制色进入系统颜色渲染。下表为普通不透明 token 组合按相对亮度公式计算的对比（普通正文 AA 目标 4.5:1，大号正文 3:1）。半透明玻璃、任意封面背景、禁用态与所有焦点色没有逐像素穷举。[深色 token](../../apps/ui/src/design/tokens.css#L1) · [高对比与强制色](../../apps/ui/src/design/liquid-glass.css#L780) · [W3C 最低文本对比](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)

| 文本 / 背景           |    常规 | 系统提高对比 |
| --------------------- | ------: | -----------: |
| ink / page            | 16.44:1 |      16.44:1 |
| muted / panel         |  8.43:1 |      11.07:1 |
| subtle / panel-raised |  6.08:1 |       7.05:1 |
| accent-hover / panel  |  6.05:1 |       6.05:1 |

同一浏览器逐项实测 8 个 CSS 视口。1440×900、1024×768、744×600、1400×600 显示工作台；743×600、768×1024、1401×600、390×844 显示“当前窗口尺寸不受支持”。八个宽度均无页面水平溢出。门槛由最小宽高、横向和最大宽高比共同决定；手机竖屏是提示页。此结果覆盖 Chromium 模拟视口，Safari、触屏硬件和多种系统缩放仍需设备验收。[断点](../../apps/ui/src/style.css#L2283) · [提示组件](../../apps/ui/src/main.tsx#L12)

## 状态、焦点、许可与键盘修复的验收边界

**D6-06 · 初始连接重试。** 原会话读取 effect 只在挂载时执行，三次传输尝试用尽后只能整页刷新。现在错误页可触发新一次有界读取，退出待确认仍由原先的锁页流程处理。独立回滚范围为 App、useSession、退出恢复场景及中英文 README。[读取入口](../../apps/ui/src/features/auth/use-session.ts#L28) · [浏览器验收](../../tests/e2e/logout-recovery.mjs#L15)

**D6-07 · 键盘创建录像选区。** 原轨道仅提供聚焦能力，两个键盘手柄只在选区已经存在时渲染。现在轨道可创建当前可见范围的草稿，两个手柄共享边界并复用现有提交路径。本批涉及 TrackBoard、时间线浏览器场景及中英文 README。[编辑与提交](../../apps/ui/src/features/timeline/TrackBoard.tsx#L193) · [真实浏览器验收](../../tests/e2e/timeline-preview.mjs#L100)

**D6-08 · P1 · WebKit 触摸截图。** Linux WebKit 27.2 会在可信的触摸 pointerup 后再派发一个标为 mouse 的兼容 click。改动前，单指轻点只发了一次错误收藏，播放位置未变。现在用最近一次真实 pointerdown 的来源识别后续 click，同位置的真实鼠标和键盘激活仍交付。改动后的真实 WebKit 场景验证单指点播没有收藏写入、连续双击只写一次、可信长按区间、两页反选和回缩、工具栏提交与粉色收藏框。原 PIN 与媒体均来自本地合成服务；浏览器输入使用 WebKit 引擎协议。所测 Linux WebKit 与 iPhone 或 iPad 实机的事件派发、系统缩放仍有设备差异。证据包包含协议和 `isTrusted` 轨迹，详见 `webkit/RESULTS.md`。[触摸与兼容点击](../../apps/ui/src/features/snapshots/use-snapshot-selection.ts#L318) · [混合输入回归](../../apps/ui/src/features/snapshots/use-snapshot-selection.test.ts#L341)

B34 的 Chromium 场景记录本次拖动开始后的页码、边缘方向和发生时间。受控地把验证者延迟 850 毫秒，旧谓词读到新页且预告已清仍超时。新断言从时间序列确认反向驻留 448.4 毫秒并实际到达第一页，随后完成其余手势。一次自然超时的原日志没有页码轨迹，因此只能确定受控实验的原因。[翻页证据断言](../../tests/e2e/snapshot-gestures.mjs#L267) · [本次反向拖动](../../tests/e2e/snapshot-gestures.mjs#L298)

B35 修正了跨页收藏工具栏的验收时序。6 项写入成功后，30 项页面读数可以带来较新的版本，选区会重新读取这 6 项。实际工具栏在读取期间仅显示「清除选择」，随后恢复「取消收藏、清除选择」。旧验收在两次浏览器调用中分别等第一个按钮和读取全组，遇到刷新便误报。B35 改为单次 DOM 采样比较完整的可见按钮名称和数量，沿用 10 秒时限。控制真实读请求顺序时，旧断言失败，新断言和原样 Chromium 完整场景通过。一次手动返回第 1 页的超时原本缺少当时的页码。后续独立诊断捕捉到相同测试将指针停在下缘，连续从第 1 页翻到第 3 页，其后的「上一页」实际回到第 2 页。

上述收藏按钮与状态读取属于 B35 当时的交互。现行拖选在松手时提交选区并翻转收藏，验收覆盖双向翻页、缩小选区和每次松手的一次提交。[现行手势验收](../../tests/e2e/snapshot-gestures.mjs)

B37 在检测到目标页码时立即把仍按下的指针移出边缘，再等该页的收藏数据。使用同一个协议会话连续送出末尾的两次真实触点，断言按下、抬起、同一位置、同一单元和 300 ms 窗口。在与正式发布文件逐字节匹配的 B36 UI 上，Linux WebKit 27.2 复跑完整场景通过，可信触摸长按为 441 ms。[页码与指针时序](../../tests/e2e/snapshot-gestures.mjs#L251) · [触点时间差](../../tests/e2e/snapshot-gestures.mjs#L430)

**D6-09 · P2 · 截图工具在按下后移动。** 真实 Chromium 将跨页 6 项加入收藏，按住「上一页」时放行新的选区查询，旧按钮横移 −17.16 px，抬起与点击落在按钮外，页码仍为 2/3。另一轮「清除选择」横移 +96.84 px，抬起命中「取消收藏」，点击落在公共父元素，选区保留。B36 将选择模式工具栏对齐起点并给各动作保留固定位置。相同手势下两项位移都为 0，实际分别回到 1/3、清空选择且没有额外收藏写入。320/600 px 回归另检查 5 种状态变化，横向滚动、按钮数量、顺序及键盘可达性沿用组件语义。真实业务按键检验覆盖桌面 Chromium。[位置与列](../../apps/ui/src/style.css#L1979) · [可访问按钮及顺序](../../apps/ui/src/features/snapshots/SnapshotToolbar.tsx#L86) · [物理按键验收](../../tests/e2e/snapshot-toolbar-layout.mjs#L60)

| ID / 影响                         | 根因与修改                                                                                                                                                                                                                                | 红→绿及回滚范围                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D6-03 · P2 · 历史空态误导         | 首次响应前与成功空数组共用初始 []。现用 null 表示尚未首读，以 aria-busy 和读取提示呈现，保留原分页合并/确认逻辑。                                                                                                                         | 真实 Chromium 与受控事件 GET；旧实现等待响应时已经有 1 个“暂无”元素，修复后依次见忙碌、空态、真实渲染的合成列表。history-follow 全场景通过，HistoryPanel 单测 2/2。独立回滚 [组件](../../apps/ui/src/features/history/HistoryPanel.tsx#L63) 和 [用例](../../tests/e2e/history-follow.mjs#L41)。                                                                                    |
| D6-04 · P2 · 时间线键盘焦点不可见 | 可聚焦 div 同时受全局焦点样式抑制，当前行没有补充标记。用 focus-visible 选择器在其固定标签边缘做指示，保留整条轨道和播放器原样式。                                                                                                        | 真实 Chromium 键盘移入再移出，旧 CSS 断言失败，修后 ui-style 通过。独立回滚 [功能样式](../../apps/ui/src/features/timeline/timeline.css#L60) 和 [用例](../../tests/e2e/ui-style.mjs#L579)。                                                                                                                                                                                        |
| D6-05 · P2 · 分发依赖清单缺项     | 旧 runtime 以手列 notices 提供，scheduler 确实进了浏览器包却没有包名清单，React DOM 文件另含同权利人的 MIT 文本。这是分发归属的证据缺口。采用 Vite 原生 build.license 给实际发出的外部依赖生成可定位许可，随 D6-02 自动从九个更新为八个。 | 旧构建读取清单报 ENOENT；正式用例实际执行 Vite，检查完整 scheduler 上游许可与按需 HLS，本批构建脚本测试 5/5，加入 D6-02 后为 6/6。最终清单 9,258 字节，首屏不请求。配置、构建验收、中英文第三方文档为本批边界。[配置](../../apps/ui/vite.config.ts#L18) · [验收](../../scripts/build-release.test.mjs#L9) · [中文说明](../third-party.md#L7) · [英文说明](../third-party.en.md#L7) |

许可证复核区分锁文件、已安装模块与最终分发。锁定依赖中没有独立安装 void-elements。html-parse-stringify 的已安装文件内嵌同类 void 标签表，但其模块没有出现在实际 rendered modules 中；React DOM 有自己的标签表且确实进入初始 chunk。没有证据将单独的 void-elements 包列为本次浏览器产物。runtime 中原有手列上游文件继续位于 /app/licenses，新清单位于 /app/apps/ui/dist/assets/third-party-licenses.md。隔离 HTTP 实例匿名 GET /assets/third-party-licenses.md 返回 200，9,258 字节与发布文件逐字节一致；八个标题含 scheduler 0.23.2 与 hls.js 1.7.4。核验日志为 `.local/audit-closure/frontend/runtime-notice.log`。该核对没有对所有依赖的法律义务作独立裁定。[分发说明](../third-party.md#L7)

本机复核文件在 `.local/audit-closure/frontend/`，另外两批保留 `logo-red.log / logo-green.log`、`zod-red.log / zod-green.log`、`zod-contract.log` 与 `zod-http.log`。状态、焦点与许可三批分别保留 `history-red-indicator.log / history-green.log`、`focus-red.log / focus-green.log`、`license-red.log / license-green.log`。另有测试夹具修复。Playwright 1.64.1 同时扣住两个 GET 后开始移除路由，先交付的响应能令另一个请求提前直通上游。两处滚动与导航场景现关闭新拦截读取，待已开始的响应交付后释放浏览器，仍验证原有渲染、排序和滚动断言。独立的双请求 Chromium 用例在旧路径抛出 Route is already handled，修后收到两个改写响应，且第三个迟到请求被拒绝。复跑还覆盖 1 日和 7 日滚动窗。[排空生命周期](../../tests/e2e/support/route-drain.mjs#L3) · [并发交付回归](../../tests/e2e/route-drain.mjs#L31) · [正式场景入口](../../scripts/run-browser-tests.mjs#L12)

前述键盘和会话修复当时的对照见 `keyboard-red.log`、`session-red.log` 和 `keyboard-session-frozen.log`，92 个 UI 测试文件的 569 个用例通过。构建、Chromium、类型与 ESLint 检查在容器内完成，浏览器使用合成夹具；移动真机、生产数据量、真实服务器缓存分发和屏幕阅读器均不在这些实跑结果中。
