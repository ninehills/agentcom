# agentcom Worker

这是 agentcom 的 Cloudflare Worker 服务端。

- `/auth/*`：给人用，必须登录 Cloudflare Access，例如获取 device token、查看设备列表。
- `/ws`：给 agent 客户端用，不走 Cloudflare Access；Worker 内部会用 device token / 设备签名鉴权。

## Wrangler 配置文件

这里有两个部署目标：

| 目标 | Worker 名 | 配置文件 | 是否提交到 Git |
|---|---|---|---|
| 线上 | `agentcom` | `server/agentcom/wrangler.toml` | 否，本地文件 |
| 测试 | `agentcom-test` | `server/agentcom/wrangler.test.toml` | 是 |

线上 `wrangler.toml` 里会包含真实的 `TEAM_DOMAIN` 和 `POLICY_AUD`，所以不要提交到 Git。

## 新手配置 Cloudflare Access

下面假设线上 Worker 地址是：

```text
https://agentcom.swulling.workers.dev
```

### 1. 只保护 `/auth/`

进入 Cloudflare Zero Trust：

```text
Zero Trust → Access → Applications → Add application → Self-hosted
```

在 **Public hostnames** 里添加：

```text
agentcom.swulling.workers.dev/auth/
```

如果 UI 拆成两个字段，就这样填：

```text
Domain: agentcom.swulling.workers.dev
Path: /auth/*
```

这样只有 `/auth/*` 会要求 Cloudflare 登录，`/ws` 会保持公开，正好符合 agentcom 的设计。

### 2. 配置允许访问的人

在这个 Access application 的 policy 里允许你的账号或邮箱。

例如：

```text
Allow → Include → Emails → swulling@gmail.com
```

### 3. 从测试配置拷贝出线上 `wrangler.toml`

不要在 Cloudflare 页面里配置 `TEAM_DOMAIN` / `POLICY_AUD`。线上配置放在本地 `server/agentcom/wrangler.toml`，这个文件已被 `.gitignore` 忽略，不会提交。

从测试配置拷贝一份：

```bash
cp server/agentcom/wrangler.test.toml server/agentcom/wrangler.toml
```

如果你已经在 `server/agentcom` 目录里：

```bash
cp wrangler.test.toml wrangler.toml
```

然后编辑 `wrangler.toml`：

```toml
name = "agentcom" # 测试配置里是 agentcom-test，这里改成 agentcom

[vars]
TEAM_DOMAIN = "https://<team>.cloudflareaccess.com"
POLICY_AUD = "<Application Audience AUD Tag>"
# 删除测试专用的 AGENTCOM_TEST_ACCESS_EMAIL
# 不要把 DEVICE_TOKEN_HMAC_SECRET 写在这里，secret 用 wrangler secret put 设置
```

这两个值从这里拿：

- `TEAM_DOMAIN`：Zero Trust 主页里的 **Team name**。例如 Team name 是 `ninehills`，就填 `https://ninehills.cloudflareaccess.com`。
- `POLICY_AUD`：这个 Access application 里的 **Application Audience (AUD) Tag**。

### 4. 设置线上 secret

`DEVICE_TOKEN_HMAC_SECRET` 不在页面上配置，也不写进 `wrangler.toml`，用 Wrangler secret 设置。

先生成一个随机值：

```bash
openssl rand -base64 32
```

然后写入 Worker secret。不要把 secret 粘到聊天、README 或 `wrangler.toml` 里。

如果你在仓库根目录执行：

```bash
npx wrangler secret put DEVICE_TOKEN_HMAC_SECRET --config server/agentcom/wrangler.toml
```

如果你已经在 `server/agentcom` 目录里执行：

```bash
npx wrangler secret put DEVICE_TOKEN_HMAC_SECRET --config wrangler.toml
```

### 5. 部署

线上部署：

```bash
npx wrangler deploy --config server/agentcom/wrangler.toml
```

因为线上 `TEAM_DOMAIN` / `POLICY_AUD` 已经写在本地 `wrangler.toml`，这里不需要 `--keep-vars`。

测试部署：

```bash
npx wrangler deploy --config server/agentcom/wrangler.test.toml
```

### 6. 验证

打开：

```text
https://agentcom.swulling.workers.dev/auth/devices
```

正常结果：

1. 先跳到 Cloudflare Access 登录页。
2. 登录后回到 `/auth/devices`。
3. 看到设备列表页面，而不是 `Unauthorized`。

再确认 `/ws` 没有被 Access 拦住：

```bash
curl -i https://agentcom.swulling.workers.dev/ws
```

应该返回 `426 Expected Upgrade: websocket`。这说明 `/ws` 是公开入口，只等待 WebSocket upgrade。

