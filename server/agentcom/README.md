# agentcom Worker 开发、测试、配置与上线手册

`server/agentcom` 是 agentcom 的 Cloudflare Worker 服务端。它负责两类入口：

- `/ws`：agent 客户端使用的公开 WebSocket 入口。它不依赖 Cloudflare Access，而是在协议层使用一次性 device token 与设备公钥签名鉴权。
- `/auth/*`：人使用的网页登录入口，例如生成 device token、查看设备、撤销设备。线上环境必须由 Cloudflare Access 保护。

本文从开发者角度说明一次完整流程：本地开发 → 自动化测试 → 测试环境真实集成测试 → 配置生产环境 → 上线 → 验证与排查。

## 1. 代码结构

```text
server/agentcom/
  src/index.ts             # Worker 入口 + ComRoom Durable Object
  test/worker.test.ts      # 基于 @cloudflare/vitest-pool-workers 的 Worker/DO 测试
  wrangler.test.toml       # 可提交的测试 Worker 配置，部署到 agentcom-test
  wrangler.toml            # 本地生产配置，已被 .gitignore 忽略，不提交
  README.md                # 本文件

packages/protocol/
  src/messages.ts          # WebSocket 消息协议类型
  src/types.ts             # Session、message、attachment 等共享类型

scripts/
  agentcom-real-integration.mjs # 真实线上/测试 Worker 集成测试脚本
```

服务端核心状态在 `ComRoom` Durable Object 中：

- `token:<hash>`：网页登录后生成的短期一次性 device token。
- `device:<deviceId>`：已注册设备、公钥、邮箱、lastSeen、revokedAt。
- `node:<nodeId>`：设备对应的 nodeName、hostname、邮箱等展示信息。
- 在线 session 保存在 WebSocket hibernation attachment 中，DO 唤醒时会重新 hydrate。

## 2. 前置条件

在仓库根目录执行：

```bash
npm install
npx wrangler --version
npx wrangler whoami
```

要求：

- Node.js 支持原生 `fetch`、`WebSocket`、`crypto.subtle`。当前开发环境使用 Node 25。
- Wrangler 已登录有权限的 Cloudflare 账号。
- Cloudflare Zero Trust Access 可能需要绑定信用卡，但 agentcom 的常规个人/团队使用一般在免费额度内。
- 修改 Cloudflare Worker 配置、部署或查看日志时，优先使用仓库里的 `npx wrangler ...`，避免本机全局版本不一致。

## 3. 配置模型

项目有两个 Worker 目标：

| 环境 | Worker 名 | URL | 配置文件 | 是否提交 |
|---|---|---|---|---|
| 测试 | `agentcom-test` | `https://agentcom-test.swulling.workers.dev` | `server/agentcom/wrangler.test.toml` | 是 |
| 线上 | `agentcom` | `https://agentcom.swulling.workers.dev` | `server/agentcom/wrangler.toml` | 否 |

### 3.1 测试配置

`wrangler.test.toml` 是可提交配置，当前用于真实测试环境：

```toml
name = "agentcom-test"
main = "src/index.ts"
compatibility_date = "2026-06-05"
workers_dev = true

[vars]
TEAM_DOMAIN = "https://example.cloudflareaccess.com"
POLICY_AUD = "test-audience"
DEVICE_TOKEN_HMAC_SECRET = "test-secret"
AGENTCOM_TEST_ACCESS_EMAIL = "tester@example.com"
```

注意：

- `AGENTCOM_TEST_ACCESS_EMAIL` 只允许测试环境使用。设置后 `/auth/*` 会跳过真实 Cloudflare Access JWT 校验，用固定邮箱 `tester@example.com` 进入 DO。
- `DEVICE_TOKEN_HMAC_SECRET = "test-secret"` 也只适合测试 Worker。线上必须使用 Wrangler secret。
- 测试环境 DO 是真实远端状态。集成测试会创建设备，并在测试末尾 revoke 自己创建的设备；如果测试中途被打断，可能留下测试设备记录。

### 3.2 生产配置

生产配置文件是 `server/agentcom/wrangler.toml`，已被 `server/agentcom/.gitignore` 忽略，不能提交。首次配置时从测试配置复制：

```bash
cp server/agentcom/wrangler.test.toml server/agentcom/wrangler.toml
```

然后编辑 `server/agentcom/wrangler.toml`。首次部署时可以先保留 `TEAM_DOMAIN` / `POLICY_AUD` 占位符，等 Cloudflare Access 创建完成后再回填真实值：

```toml
name = "agentcom"
main = "src/index.ts"
compatibility_date = "2026-06-05"
workers_dev = true

[observability.logs]
enabled = true
invocation_logs = true

[vars]
TEAM_DOMAIN = "https://ninehills.cloudflareaccess.com"
POLICY_AUD = "<Cloudflare Access Application Audience AUD Tag>"
# 删除 AGENTCOM_TEST_ACCESS_EMAIL
# 删除 DEVICE_TOKEN_HMAC_SECRET，线上 secret 通过 wrangler secret put 设置

[[durable_objects.bindings]]
name = "ROOM"
class_name = "ComRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ComRoom"]
```

生产环境变量说明：

| 名称 | 必填 | 设置位置 | 说明 |
|---|---:|---|---|
| `TEAM_DOMAIN` | 是 | `wrangler.toml` `[vars]` | Cloudflare Zero Trust team domain，例如 `https://ninehills.cloudflareaccess.com` |
| `POLICY_AUD` | 是 | `wrangler.toml` `[vars]` | Access application 的 Audience AUD Tag |
| `DEVICE_TOKEN_HMAC_SECRET` | 是 | Wrangler secret | HMAC device token 的密钥，不能写入 Git 或聊天记录 |
| `AGENTCOM_TEST_ACCESS_EMAIL` | 否 | 仅测试配置 | 测试环境绕过 Access 用的固定邮箱，生产必须删除 |

设置生产 secret：

```bash
openssl rand -base64 32
npx wrangler secret put DEVICE_TOKEN_HMAC_SECRET --config server/agentcom/wrangler.toml
```

## 4. Cloudflare Access 配置

agentcom 的关键设计是：只保护 `/auth/*`，不要保护 `/ws`。

原因：

- `/auth/*` 面向浏览器和人，需要 Cloudflare 登录后才能生成 device token 或管理设备。
- `/ws` 面向 agent 进程。它必须公开接受 WebSocket upgrade，然后由 agentcom 协议自行校验 device token / 设备签名。
- 如果把整个 `agentcom.swulling.workers.dev` 都放进 Access，agent 客户端无法正常连 `/ws`。

Cloudflare 控制台可以从 Worker 页面开启 Access 认证：

![在 Worker 中开启 Access](../../image-1.png)

但这样可能会把 `/ws` 也放到 Access 后面，需要进入 Zero Trust Dashboard 修改路径。

![进入 Zero Trust Dashboard](../../image-2.png)

Cloudflare Zero Trust 配置入口：

```text
Zero Trust → Access → Applications → Add application → Self-hosted
```

Public hostname 填：

```text
agentcom.swulling.workers.dev/auth/
```

如果 UI 拆字段：

```text
Domain: agentcom.swulling.workers.dev
Path: /auth/*
```

如果页面里是 Path 输入框，把 Path 设置为 `/auth/`，并确认点击页面底部的 **Save**：

![Access path 设置为 auth](../../image-3.png)

Policy 至少允许开发者邮箱，例如：

```text
Allow → Include → Emails → you@example.com
```

配置完成后，从 Access / Zero Trust 页面找到 Team domain 和 **Application Audience (AUD) Tag**：

![Team domain](../../image-4.png)

![AUD tag](../../image-5.png)

然后填入生产 `server/agentcom/wrangler.toml`：

```toml
[vars]
TEAM_DOMAIN = "https://<your-team>.cloudflareaccess.com"
POLICY_AUD = "<Cloudflare Access Application Audience AUD Tag>"
```

修改后重新部署，并记下 Wrangler 输出的 Worker URL：

```bash
npx wrangler deploy --config server/agentcom/wrangler.toml
```

![部署后的 Worker URL](../../image.png)

快速验证：

```bash
# 预期 200
curl -i https://agentcom.<account>.workers.dev/
# 预期 426，说明 /ws 没有被 Access 拦住
curl -i https://agentcom.<account>.workers.dev/ws
# 未登录时预期 302 跳转 Cloudflare Access
curl -i https://agentcom.<account>.workers.dev/auth/device
```

## 5. 本地开发流程

### 5.1 修改代码

常见修改点：

- WebSocket 协议字段：先改 `packages/protocol/src/messages.ts` 或 `types.ts`，再改 Worker 和测试。
- Worker 路由、鉴权、设备页：改 `server/agentcom/src/index.ts`。
- DO 状态结构变更：同时评估是否需要新的 Durable Object migration tag。
- 设备管理页展示：改 `handleDevices()`，并补充 `server/agentcom/test/worker.test.ts` 断言。

开发约束：

- 不要在源码或生产配置里写真实 secret。
- 不要把请求级状态放到模块级变量。DO 内存状态必须能从 storage / WebSocket attachment 恢复。
- 修改 Worker binding、变量或 Durable Object 配置后，运行 typecheck 和测试。

### 5.2 本地自动化测试

在仓库根目录运行：

```bash
npm test
npm run typecheck
```

当前单元/集成测试覆盖：

- `/` health check。
- `/auth/devices` 空状态和设备详情展示。
- `/auth/device` 生成 token 后注册设备。
- 设备 token 单次使用。
- P-256 签名重连。
- `list`、`send`、`presence`、`rename_node`、`unregister`。
- revoke 后禁止重连，且已 revoke 设备可从设备页删除。

这些测试运行在 Cloudflare Workers/Vitest 测试池里，速度快，适合每次改动后先跑。

### 5.3 可选：本地 Wrangler dev

需要手动连 Worker 时可以运行：

```bash
npx wrangler dev --config server/agentcom/wrangler.test.toml --port 8787
```

然后验证：

```bash
curl -i http://localhost:8787/
curl -i http://localhost:8787/ws
```

`/ws` 非 WebSocket 请求应返回：

```text
426 Expected Upgrade: websocket
```

## 6. 测试环境部署与真实集成测试

### 6.1 部署测试 Worker

测试环境使用提交到 Git 的配置：

```bash
npx wrangler deploy --config server/agentcom/wrangler.test.toml
```

成功输出中应包含：

```text
Uploaded agentcom-test
Deployed agentcom-test triggers
https://agentcom-test.swulling.workers.dev
```

### 6.2 运行真实集成测试

仓库提供了真实 HTTP + WebSocket 集成测试脚本：

```bash
npm run test:integration:real
```

默认目标：

```text
https://agentcom-test.swulling.workers.dev
```

也可以指定其它 Worker：

```bash
AGENTCOM_BASE_URL=https://agentcom-test.swulling.workers.dev npm run test:integration:real
# 或
node scripts/agentcom-real-integration.mjs https://agentcom-test.swulling.workers.dev
```

脚本会执行完整真实链路：

1. `GET /` health check。
2. `GET /ws` 验证未 upgrade 时返回 `426`。
3. `GET /auth/device` 获取真实 device token。
4. WebSocket `register_device` 注册 Alice。
5. 复用 token 应被拒绝。
6. 注册 Bob。
7. `list` 验证两个在线 session。
8. Alice 按 session id 向 Bob `send` 消息，并校验 `delivered` ACK。
9. `presence` 广播更新。
10. `rename_node` 并检查 list 结果。
11. `auth_begin` / `auth_finish` 使用 P-256 签名重连。
12. 错误签名应失败。
13. `/auth/devices` 页面应包含 hostname、deviceId、nodeId、email、Last seen。
14. revoke 设备后应拒绝再次重连。
15. 清理测试创建的 Bob 设备。

测试日志会写到：

```text
logs/agentcom-real-integration-<timestamp>.jsonl
```

日志为 JSONL，包含每个 HTTP 请求、响应摘要、WebSocket 收发消息和 step 耗时。`logs/` 已被 `.gitignore` 忽略，不会提交。

最近一次通过示例：

```text
PASS real integration test against https://agentcom-test.swulling.workers.dev
Log: /Users/yangtao04/src/github/ninehills/agentcom/logs/agentcom-real-integration-2026-06-05T04-25-23-179Z.jsonl
```

## 7. 生产上线流程

推荐上线顺序：

### 7.1 上线前检查

```bash
git status --short
npm test
npm run typecheck
npx wrangler deploy --config server/agentcom/wrangler.test.toml
npm run test:integration:real
```

如果真实集成测试失败，先看对应 `logs/agentcom-real-integration-*.jsonl`，不要直接上线。

### 7.2 确认生产配置

检查本地生产配置：

```bash
sed -n '1,220p' server/agentcom/wrangler.toml
```

必须确认：

- `name = "agentcom"`。
- `TEAM_DOMAIN` 是真实 Zero Trust team domain。
- `POLICY_AUD` 是生产 Access application 的 AUD Tag。
- 没有 `AGENTCOM_TEST_ACCESS_EMAIL`。
- 没有明文 `DEVICE_TOKEN_HMAC_SECRET`。

确认 secret 已存在：

```bash
npx wrangler secret list --config server/agentcom/wrangler.toml
```

应能看到 `DEVICE_TOKEN_HMAC_SECRET`。

### 7.3 部署生产 Worker

```bash
npx wrangler deploy --config server/agentcom/wrangler.toml
```

部署成功后记录输出里的 Worker URL 和 Version ID。

### 7.4 上线后验证

验证 `/ws` 没有被 Access 拦住：

```bash
curl -i https://agentcom.swulling.workers.dev/ws
```

期望：

```text
HTTP/2 426
Expected Upgrade: websocket
```

验证 `/auth/*` 受 Access 保护：

```bash
open https://agentcom.swulling.workers.dev/auth/devices
```

期望：

1. 未登录时跳转 Cloudflare Access。
2. 登录后回到 `/auth/devices`。
3. 页面标题为 `Registered devices`。
4. 已注册设备展示 nodeName、hostname、deviceId、nodeId、email、created、last seen、revoked 状态。
5. 每个设备展示当前在线 sessions，包含 Session ID、Name、Node ID、Node name、Address、CWD、Model、Runtime、PID、Started at、Last activity、Status。
6. active 设备显示 `Revoke`；revoked 设备显示 `Delete permanently`。

获取 token 并手动注册设备：

1. 打开 `https://agentcom.swulling.workers.dev/auth/device`。
2. 登录后复制页面里的命令：

   ```text
   /com join wss://agentcom.swulling.workers.dev/ws com_dev_...
   ```

3. 在 agent 客户端执行 join，期望服务端返回 `register_ok`。

## 8. 日志与排查

### 8.1 查看 Worker 实时日志

测试环境：

```bash
npx wrangler tail agentcom-test
```

生产环境：

```bash
npx wrangler tail agentcom
```

只看错误：

```bash
npx wrangler tail agentcom --status error
```

### 8.2 常见问题

#### `agentcom-test.swulling.workers.dev` 返回 Cloudflare 404

通常表示测试 Worker 尚未部署，或部署到了别的账号/名字。执行：

```bash
npx wrangler deploy --config server/agentcom/wrangler.test.toml
```

然后重跑：

```bash
npm run test:integration:real
```

#### `/auth/device` 返回 `Unauthorized`

分环境看：

- 测试环境：确认 `wrangler.test.toml` 里有 `AGENTCOM_TEST_ACCESS_EMAIL = "tester@example.com"`，并已重新部署。
- 生产环境：确认请求经过 Cloudflare Access，且 Worker 收到了合法 `cf-access-jwt-assertion`。同时检查 `TEAM_DOMAIN`、`POLICY_AUD` 是否与 Access application 匹配。

#### `/auth/*` 返回 misconfigured

Worker 会在生产模式检查 Access 配置。确认：

```toml
[vars]
TEAM_DOMAIN = "https://<team>.cloudflareaccess.com"
POLICY_AUD = "<aud tag>"
```

如果缺少 `DEVICE_TOKEN_HMAC_SECRET`，`/auth/device` 会返回：

```text
Worker misconfigured: DEVICE_TOKEN_HMAC_SECRET secret is not set
```

用下面命令修复：

```bash
npx wrangler secret put DEVICE_TOKEN_HMAC_SECRET --config server/agentcom/wrangler.toml
npx wrangler deploy --config server/agentcom/wrangler.toml
```

#### `/ws` 被 Access 拦截

说明 Access application 保护范围太大。修正为只保护：

```text
Domain: agentcom.swulling.workers.dev
Path: /auth/*
```

不要保护整个 `agentcom.swulling.workers.dev/*`。

#### 设备列表没有 hostname

先确认访问的是最新部署：

```bash
npx wrangler deploy --config server/agentcom/wrangler.toml
```

再打开：

```text
https://agentcom.swulling.workers.dev/auth/devices
```

页面应展示 hostname。如果仍没有：

1. 用浏览器强制刷新或换无痕窗口排除缓存。
2. 确认设备是用包含 `hostname` 字段的新客户端注册的。
3. 在测试环境跑 `npm run test:integration:real`，它会断言 `/auth/devices` 包含 hostname。

#### 真实集成测试 `send` 偶发超时

WebSocket 消息可能比测试代码开始等待更早到达。当前脚本已实现 per-socket 消息队列，避免 ACK 或 message 被早到消息丢掉。如果重新改脚本，不要用多个一次性 `message` listener 竞争同一个 socket。

## 9. 安全注意事项

- 生产 `DEVICE_TOKEN_HMAC_SECRET` 只能通过 `wrangler secret put` 设置。
- 不要提交 `server/agentcom/wrangler.toml`。
- 不要把生产 secret 粘贴到 issue、PR、聊天或 README。
- `AGENTCOM_TEST_ACCESS_EMAIL` 只能出现在测试配置中。
- `/ws` 公开是设计要求，不代表无需鉴权；鉴权发生在 WebSocket 协议层。
- 如果生产 secret 曾经泄露，立即重新生成并覆盖：

  ```bash
  openssl rand -base64 32
  npx wrangler secret put DEVICE_TOKEN_HMAC_SECRET --config server/agentcom/wrangler.toml
  npx wrangler deploy --config server/agentcom/wrangler.toml
  ```

## 10. 开发者提交前清单

提交或发 PR 前至少完成：

```bash
npm test
npm run typecheck
```

如果改动影响 Worker 路由、WebSocket 协议、Access 鉴权、设备注册、设备列表或 revoke 流程，还必须完成：

```bash
npx wrangler deploy --config server/agentcom/wrangler.test.toml
npm run test:integration:real
```

在 PR 描述或交接文档中记录：

- 测试 Worker 的部署结果和 Version ID。
- `npm test` / `npm run typecheck` 输出。
- 真实集成测试日志路径。
- 如果发现并修复 bug，说明复现步骤、根因和修复方式。
