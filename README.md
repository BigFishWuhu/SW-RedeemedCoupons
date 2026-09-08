# SW Coupon Console

一个可自托管的 Summoners War 礼包码兑换 Web 控制台。它从 SWGT 获取最新兑换码，通过 Playwright 在 Hive 官方兑换页完成兑换，并将账号、任务与兑换记录保存在本地 SQLite 数据库中。

## 功能

- 管理员登录与修改密码
- 添加、编辑、停用和删除多个 Hive 兑换账号
- 一键兑换全部账号，或只兑换指定账号
- 每日定时自动兑换（默认北京时间 12:00）
- 查询和筛选兑换记录、Hive 返回信息与任务状态
- 已成功或已确认兑换的礼包码自动跳过，失败记录下次可重试
- Docker Compose 部署，GitHub Actions 自动发布 GHCR 镜像

## Docker Compose 部署

需要安装 Docker 与 Docker Compose。克隆仓库后可以直接使用仓库内的 `compose.yaml`：

```bash
git clone https://github.com/BigFishWuhu/SW-RedeemedCoupons.git
cd SW-RedeemedCoupons
docker compose up -d --build
```

对应的 Compose 配置如下，可直接保存为 `compose.yaml`：

```yaml
services:
  swcoupon:
    build: .
    image: sw-redeemed-coupons:latest
    container_name: swcoupon
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - swcoupon-data:/app/data
    shm_size: 1gb

volumes:
  swcoupon-data:
```

访问 `http://服务器地址:3000`。首次访问会显示初始化向导，在页面中创建管理员用户名和密码，创建完成后自动登录。

SQLite 数据库存放在名为 `swcoupon-data` 的 Docker volume 中，更新或重建容器不会丢失。以后访问会直接显示登录页；管理员密码可在“安全设置”中修改。

## 使用 GitHub 发布的镜像

仓库的 [Docker workflow](.github/workflows/docker-image.yml) 会在推送到 `main`、推送 `v*` 标签或手动触发时，将镜像发布到：

```text
ghcr.io/<GitHub 用户或组织>/<仓库名>:latest
```

如果不想在 VPS 上构建镜像，可以使用下面的 `compose.yaml` 直接部署本仓库发布的 GHCR 镜像：

```yaml
services:
  swcoupon:
    image: ghcr.io/bigfishwuhu/sw-redeemedcoupons:latest
    pull_policy: always
    container_name: swcoupon
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - swcoupon-data:/app/data
    shm_size: 1gb

volumes:
  swcoupon-data:
```

在 `compose.yaml` 所在目录启动：

```bash
docker compose up -d
```

更新到最新镜像：

```bash
docker compose pull
docker compose up -d
```

如果 GHCR package 是私有的，先执行 `docker login ghcr.io`。也可以在 GitHub package 设置中将镜像改为 Public。

两个示例均使用默认配置，不需要创建 `.env`。如需修改端口、定时兑换时间或其他选项，可在 `environment` 中加入下方配置项。

## 配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADMIN_USERNAME` | 无 | 可选：无人值守部署时预先创建管理员 |
| `ADMIN_PASSWORD` | 无 | 可选：与 `ADMIN_USERNAME` 配合，至少 10 个字符 |
| `PORT` | `3000` | 宿主机映射端口（Compose 使用） |
| `APP_TIMEZONE` | `Asia/Shanghai` | 定时任务使用的 IANA 时区 |
| `AUTO_REDEEM` | `true` | 是否启用每日自动兑换 |
| `AUTO_REDEEM_HOUR` | `12` | 自动兑换小时，0–23 |
| `AUTO_REDEEM_MINUTE` | `0` | 自动兑换分钟，0–59 |
| `REDEEM_DELAY_MS` | `4500-12000` | 两次礼包码兑换间的随机延迟 |
| `ACTION_DELAY_MS` | `800-2200` | 检查账号和确认兑换之间的随机延迟 |
| `PAGE_TIMEOUT_MS` | `30000` | Hive 页面操作超时 |
| `SESSION_HOURS` | `168` | 登录会话有效小时数 |
| `DATA_DIR` | `/app/data` | SQLite 数据目录 |

如果使用 Nginx、Caddy 或 Traefik 提供 HTTPS，请将请求反向代理至容器的 3000 端口，并保留 `Host` 和 `X-Forwarded-Proto` 请求头。应用会在 HTTPS 下自动给登录 Cookie 加上 `Secure`。

## 本地开发

需要 Node.js 22.5 或更新版本以及系统可用的 Chromium：

```bash
npm ci
npx playwright install chromium
npm start
```

运行静态检查和测试：

```bash
npm run check
npm test
```

## 数据与备份

主数据库为 `/app/data/swcoupon.sqlite`。容器运行时 SQLite 使用 WAL 模式，建议备份整个 `swcoupon-data` volume，或在停止容器后复制数据库文件。删除兑换账号不会删除其历史兑换记录；历史行会保留当时的账号名称、Hive ID 和服务器信息。

> 本项目依赖 SWGT 与 Hive 官方页面的结构和可用性。上游页面调整或风控可能导致兑换失败，具体原因可在“兑换记录”的返回信息中查看。
