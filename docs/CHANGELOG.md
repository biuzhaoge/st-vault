# 更新日志 · Changelog

## 0.2.0

### 中文

- 录像删除按页生成清单并分批回收空间。已确认任务可排队，重启后继续处理。
- 截图区支持点击播放、双击切换收藏和拖动批量反选。历史空白日期自动清理，当天保留。
- 主播筛选支持多选。点击列表序号切换录制，曾用名集中显示在播放器标题栏。
- 升级沿用现有数据、媒体和 PostgreSQL 挂载。

### English

- Recording deletion reclaims files as durable plan pages become available. Confirmed jobs queue and resume after restart.
- Click a screenshot to play, double-click to toggle its favorite status, or drag to toggle a range. Empty historical days are cleaned up while today is retained.
- Directory filters support multiple statuses. Click a row number to toggle recording. Former names appear in the player header.
- Keep existing data, media, and PostgreSQL mounts when upgrading.

## 0.1.1

### 简体中文

- **工作台与触屏。** 桌面和平板横屏共用布局，缩放时菜单、时间线和截图按钮保持可用。触屏可上下滚动主播列表、横拖时间线取段、上下滑动截图翻页。手机、竖屏和过小的窗口显示尺寸提示。
- **时间线与列表滚动。** 滚动时保留仍在视野内的行和轨道，只为新进入视野的行加载并呈现数据。视图最右可浏览到今天午夜。状态轨道和录像覆盖轨道使用一致的底纹，便于辨认空白和实际覆盖。
- **截图与收藏。** 收藏按钮移到截图左上角，移除图片上的时间戳。已收藏的覆盖范围用粉色显示，优先于已看和未看颜色。删除非喜欢录像后，从原选区重新吸附到剩余覆盖。选区清空时关闭回放并保持列表浏览位置。
- **账户同步与状态。** 登录后后台立即补齐头像和默认封面，新加入的主播也立即排队下载，已有图片只在变化时更新。状态面板按事项展示结果、说明和可用的重试操作，存储条合并显示已用比例和剩余空间。密钥面板的输入、可用标签与账户面板对齐。
- **部署与存储。** Compose 默认映射 `10002:10002`，可信局域网可直接用 HTTP，现有 HTTPS 反向代理可继续使用。启动时检查 PostgreSQL 数据目录和 WAL 所在文件系统，避免在 9p 或 SMB 挂载上运行。PostgreSQL 仍为 18，升级时保留现有 `data`、`media` 和数据库挂载。Windows Docker Desktop 可将数据库放在 WSL 的 Linux 文件系统或本地 Docker 卷。

镜像 `biuzhaoge/st-vault:0.1.1` 和 `latest` 同时支持 `linux/amd64` 与 `linux/arm64`。

### English

- **Workspace and touch controls.** Desktop and landscape tablets share one layout that keeps menus, timelines, and screenshot controls usable as the window resizes. Swipe vertically to scroll the list or page through screenshots, and drag horizontally on a timeline to select footage. Phones, portrait screens, and undersized windows show a display-size prompt.
- **Timeline and list scrolling.** Rows that remain visible keep their loaded tracks. Only newly visible rows load and reveal data as you scroll. The view extends through midnight today. Matching status and coverage tracks make gaps and recorded footage easier to distinguish.
- **Screenshots and favorites.** The favorite button sits in the top-left corner of each screenshot, with no timestamp overlay. Favorite footage appears pink above the seen or unseen color. Deleting non-favorites snaps the original selection to remaining footage. If the range is empty, playback closes and the list stays at its current scroll position.
- **Account sync and status.** Sign-in immediately queues missing avatars and default covers, and newly followed broadcasters get the same treatment. Cached images refresh only when they change. Status rows show results, explanations, and retry actions where available. One storage bar shows used capacity and free space. The key panel aligns its entry and availability indicator with the Account panel.
- **Deployment and storage.** Compose publishes `10002:10002` by default. Direct HTTP works on trusted LANs, and existing HTTPS reverse proxies remain supported. Startup checks the PostgreSQL data and WAL filesystems and refuses 9p and SMB mounts. PostgreSQL stays on version 18. Keep your existing `data`, `media`, and database mounts when upgrading. On Windows Docker Desktop, database storage can use a WSL Linux filesystem or a local Docker volume.

The `biuzhaoge/st-vault:0.1.1` and `latest` tags support both `linux/amd64` and `linux/arm64`.

## 0.1.0

### 简体中文

ST-Vault 首个正式版。把公开直播的观看、录制和回看集中在一个可部署到 NAS 的工作台。

- **同步关注与录制。** 用账户 Cookies 同步 Stripchat 的关注清单，按主播开启自动录制。名称变更自动保留曾用名，归档的主播仍可查看已有录像。
- **从时间线找到想看的片段。** 状态与录像覆盖分轨显示。点击封面看直播，拖选有录像的范围回看，再点击截图定位到对应画面。
- **按录像单元管理媒体。** 支持用桃心保留片段，批量删除会保护喜欢的录像。已接受的删除任务在后台执行，并可在重启后继续。
- **单容器部署。** 包含 PostgreSQL，应用数据和媒体可分别挂载。提供中英文界面、运行状态面板和 Compose 部署模板。

镜像 `biuzhaoge/st-vault:0.1.0` 同时支持 `linux/amd64` 和 `linux/arm64`。新部署可直接使用文档中的 Compose 模板。替换现有容器时，请先备份 `data` 和 `media` 并保持原挂载路径。

### English

The first official ST-Vault release brings public livestream viewing, recording and replay into a single workspace for your NAS.

- **Sync follows and record.** Import your Stripchat following list with account cookies and enable automatic recording per broadcaster. ST-Vault remembers previous names and keeps existing recordings browsable in the archive.
- **Find footage on the timeline.** Broadcast status and recording coverage appear on separate tracks. Click a cover to watch live, select a recorded range to replay it, or click a snapshot to jump to its footage.
- **Manage complete recording units.** Favorite clips to protect them from bulk deletion. Accepted deletion jobs run in the background and can resume after a restart.
- **Deploy one container.** PostgreSQL is included, with separate mounts for app data and media. The workspace includes English and Simplified Chinese, a status panel and a Compose template.

The `biuzhaoge/st-vault:0.1.0` image supports `linux/amd64` and `linux/arm64`. Start a fresh deployment with the documented Compose template. When replacing an existing container, back up `data` and `media` first and keep their mount paths.
