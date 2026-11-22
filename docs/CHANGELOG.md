# 更新日志 · Changelog

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
