<p align="center">
  <img src="apps/ui/public/assets/st-vault-mark.png" width="88" height="88" alt="ST-Vault 标识">
</p>

<h1 align="center">ST-VAULT</h1>

<p align="center"><strong>你的直播时光库</strong></p>
<p align="center">少拖进度条，多看你想看的时刻。<br>记录 · 回看 · 收藏</p>

<p align="center"><strong>简体中文</strong> · <a href="README.en.md">English</a></p>

---

把主播最近的播出状态、录制覆盖和代表截图放在同一张时间线上。**先看什么时候播过，再划出有画面的范围，通过截图定位你感兴趣的高光。** 部署在自己的 NAS，用浏览器看直播、回顾录像，把喜欢的片段留下。

[开始部署](#开始部署) · [连接账户](#连接账户) · [获取密钥](#获取密钥) · [更新日志](docs/CHANGELOG.md) · [Docker 镜像](https://hub.docker.com/r/biuzhaoge/st-vault)

![播放器、主播列表与状态和录像双轨](docs/assets/screenshots/workbench.png)

示例画面使用合成测试数据。

## 从一场直播，找到想看的那一段

**同步喜欢的主播。** 连接 Stripchat 账户的关注列表，免去逐个手动添加。名称变化自动记录曾用名，取关后仍可浏览已有录像。

![账户面板中的站点选择与 Cookies 输入框](docs/assets/screenshots/account.png)

**直播与回看在同一面板。** 点击封面直接看公开直播，开启自动录制后保存最高可用源画质。拖选录到的范围，再点截图跳到对应画面；短空档留白，长空档压缩，不必反复拖动进度条。

![录像回放与当前播放位置](docs/assets/screenshots/playback.png)

**喜欢的画面长期留下。** 桃心保护对应完整录像单元，不受保留天数清理；截图工具栏直接提供“取消所有喜欢”和“删除所有非喜欢”，均作用于整个当前时间范围（包含其他页）；单张喜欢由桃心切换。运行进度在状态面板查看，刷新或关闭网页不会中断已接纳的删除任务。

![全屏回放与截图管理侧栏](docs/assets/screenshots/fullscreen.png)

## 开始部署

公开镜像 `biuzhaoge/st-vault:latest` 支持 **linux/amd64 和 linux/arm64**。Docker 会自动选择架构，拉取无需登录。Compose 和 Docker CLI 任选一种，同一组数据目录只供一个容器使用。

GitHub 保存源码和正式发布说明，Docker Hub 提供经验证的镜像。需要固定部署时，可选明确的版本标签。[GitHub 发布](https://github.com/biuzhaoge/st-vault/releases) · [镜像版本](https://hub.docker.com/r/biuzhaoge/st-vault/tags)

### Docker Compose

把下面的内容保存为 `compose.yml`，在同一目录执行启动命令。也可以直接下载仓库里的[同一份模板](compose.yml)。

```yaml
name: st-vault
services:
  app:
    image: biuzhaoge/st-vault:latest
    ports:
      - '127.0.0.1:10002:10002'
    volumes:
      - ./data:/data
      - ./media:/media
    mem_limit: 2g
    init: true
    restart: unless-stopped
    stop_grace_period: 180s
    logging: { driver: local }
```

```sh
docker compose up -d
```

### Docker CLI

在 NAS 或 Linux 的部署目录执行以下命令。录像和配置会保存在当前目录下的 `media` 和 `data`。

```sh
docker run -d --name st-vault --restart unless-stopped \
  -p 127.0.0.1:10002:10002 --memory 2g \
  -v "$PWD/data:/data" -v "$PWD/media:/media" \
  --init --stop-timeout 180 --log-driver local \
  biuzhaoge/st-vault:latest
```

### 需要时再改参数

- **局域网访问**。默认地址是 <http://127.0.0.1:10002>。要从可信局域网直连，把 `ports` 或 `-p` 中的 `127.0.0.1` 换成 NAS 的私有 IP。修改端口时只改宿主机一侧。
- **存储位置**。修改 `volumes` 或 `-v` 中冒号前的宿主机路径。保存 PostgreSQL 和私有配置的 `data` 建议用本地 SSD，录像目录 `media` 可放在大容量硬盘。
- **内存上限**。从 `2g` 起步。多路录制时若经常碰到上限，再增大 `mem_limit` 或 `--memory`。
- **时区与版本**。默认时区是 `Asia/Shanghai`。更换时在 Compose 的 `environment` 中添加 `TZ: America/New_York`，或在 CLI 中加 `-e TZ=America/New_York`。将 `latest` 改为 `0.1.0` 可固定此版本。

通过域名或公网 IP 访问时，使用支持 SSE 的 HTTPS 反向代理并保留原始 Host。需要显式启用 HTTPS 代理模式时，设置 `STV_SECURE_COOKIE=1`。

升级时沿用原来的 `data` 和 `media` 路径，以及已配置的端口、环境变量和 UID/GID。停机宽限给内置 PostgreSQL 留出安全关闭的时间，`local` 日志驱动会自动轮转。

首次打开时设置六位 PIN。进入工作台后可连接账户，播放加密直播前需导入密钥。直播连接超时时，可在播放器的 CDN 菜单手动测速并选择节点。测速会下载小段媒体作比较。更换节点会让所有直播和录制立即重新连接，期间可能短暂停顿。

状态面板的异常行会提供可用的「重试」操作，由后台完成检查或恢复。Cookies 失效时请到「账户」更新。磁盘只读或空间不足时，请先处理存储问题再重试。

## 连接账户

1. 在账户面板选择站点，然后在浏览器登录同一域名。
2. 在已登录的标签页打开 Cookie-Editor，选择 **Export → JSON**。
3. 将完整 JSON 数组粘贴到 ST-Vault 账户面板，点击「连接并同步」。换域名时先断开旧账户，再导入新域名的 Cookies。[Cookie-Editor](https://cookie-editor.com/)

![Cookies JSON 导出示意](docs/assets/cookies-export.svg)

## 获取密钥

从公开密钥列表选择匹配的条目。JSON 属性名是 `pkey`，对应值是 `pdkey`。打开播放器钥匙面板，将一对密钥按 `pkey:pdkey` 格式粘贴并添加，中间使用英文冒号。上游会轮换密钥，请以面板验证结果为准。[公开密钥列表](https://github.com/kesamom/stripchat_mouflon/blob/main/stripchat_mouflon_keys.json) · [社区讨论](https://github.com/lossless1024/StreaMonitor/issues/359)

密钥配置参考了两个第三方项目。[StripchatRecorder](https://github.com/ChanTrail/StripchatRecorder/blob/master/README.en.md#mouflon-hls-decryption-keys) · [scp-standalone](https://github.com/aitschti/scp-standalone#files)

## 备份恢复与更新

停止容器后备份完整的 `data`、`media` 和部署配置，保留备份对应的镜像。Compose 更新用 `docker compose pull && docker compose up -d`。只迁移 `media` 可以重建媒体索引，PIN、账户和密钥需重新配置。[维护说明](docs/CONTRIBUTING.md)

## 使用边界

- 只访问和保存公开可用直播，不解锁私密/付费内容，不代替原站真人验证。
- 账户通过用户浏览器导出的 Cookies 接入；状态和媒体匿名获取。
- 只能回看本地已保存画面，网络、上游缺片、资源不足可能留下空档，无法补回不存在的内容。
- 原流保存，不提升源画质；截图后台软件解码，积压时继续追赶，没有 GPU 依赖。
- 单管理员、多客户端；数据目录由单实例独占，删除不可撤销，请备份。

[架构与存储](docs/architecture.md) · [API](docs/api.md) · [维护说明](docs/CONTRIBUTING.md)

## 权利与免责声明

本项目与 Stripchat 及其运营方无隶属或背书关系。请仅访问、保存和使用已获授权的内容，遵守适用法律、网站条款及相关人员的隐私与内容权利；能够访问不代表可以转载或分发。

原创代码采用 [Apache-2.0](LICENSE)，第三方组件遵循[各自许可](docs/third-party.md)。软件按现状提供，不保证不中断或数据不丢失。会话、访问入口和备份由部署者妥善管理，详见[安全说明](docs/SECURITY.md)。
