# 交接：Issue #1 / PR #5

## 当前状态

- Issue: #1「实现协议契约与 Worker 房间基础」
- PR: https://github.com/ninehills/agentcom/pull/5
- 分支: `issue-1-worker-protocol`
- 当前基线提交：`2f8bb3a add issue-1 handoff`
- PR 状态：open，目标是继续把本轮真实集成测试脚本、README 更新和交接更新提交并推送到当前分支。
- 本轮工作区改动：`package.json`、`server/agentcom/README.md`、`scripts/agentcom-real-integration.mjs`、`docs/handoff/issue-1.md`。

## 已完成内容

关键落点：

- 协议包：`packages/protocol/`
- Worker + Durable Object：`server/agentcom/src/index.ts`
- Worker 测试：`server/agentcom/test/worker.test.ts`
- 测试 Wrangler 配置：`server/agentcom/wrangler.test.toml`
- Worker 开发/测试/上线手册：`server/agentcom/README.md`
- 真实集成测试脚本：`scripts/agentcom-real-integration.mjs`

已实现能力包括：设备 token 注册、P-256 签名重连、list/send/presence/rename/unregister、设备撤销、Access JWT 校验、设备管理页空状态与设备详情展示。

本轮额外完成：

1. 新增真实集成测试脚本 `scripts/agentcom-real-integration.mjs`。
2. 在 `package.json` 新增脚本：

   ```bash
   npm run test:integration:real
   ```

3. 重写 `server/agentcom/README.md`，从开发者视角覆盖：
   - 代码结构与状态模型；
   - 测试/生产配置；
   - Cloudflare Access 只保护 `/auth/*` 的配置；
   - 本地开发与自动化测试；
   - 测试环境部署和真实集成测试；
   - 生产上线流程；
   - Wrangler tail 日志和常见问题排查；
   - 安全注意事项与提交前清单。

## 真实集成测试脚本

默认测试目标：

```text
https://agentcom-test.swulling.workers.dev
```

运行：

```bash
npm run test:integration:real
```

也可以指定目标：

```bash
AGENTCOM_BASE_URL=https://agentcom-test.swulling.workers.dev npm run test:integration:real
node scripts/agentcom-real-integration.mjs https://agentcom-test.swulling.workers.dev
```

覆盖真实 HTTP + WebSocket 链路：

1. `GET /` health check。
2. `GET /ws` 验证非 WebSocket upgrade 返回 `426 Expected Upgrade: websocket`。
3. `GET /auth/device` 获取真实 device token。
4. WebSocket `register_device` 注册 Alice。
5. 复用 device token 被拒绝。
6. 注册 Bob。
7. `list` 验证两个在线 session。
8. Alice 按 session id 给 Bob `send`，校验 Bob 收到 `message`，Alice 收到 `delivered` ACK。
9. `presence` 广播更新。
10. `rename_node` 并检查 list 结果。
11. `auth_begin` / `auth_finish` 使用 P-256 签名重连。
12. 错误签名被拒绝。
13. `/auth/devices` 页面包含 hostname、deviceId、nodeId、email、Last seen。
14. revoke 设备后拒绝未来重连。
15. 清理测试创建的 Bob 设备。

测试日志写入：

```text
logs/agentcom-real-integration-<timestamp>.jsonl
```

`logs/` 已被 `.gitignore` 忽略，不提交。

## 验证结果

本轮先运行了本地测试，已通过：

```bash
npm test
npm run typecheck
```

结果：

- `server/agentcom/test/worker.test.ts`
- 1 个测试文件通过
- 8 个测试通过
- TypeScript build 通过

真实集成测试过程：

1. 首次运行：

   ```bash
   npm run test:integration:real
   ```

   失败在 `GET /`，返回 Cloudflare 404。日志：

   ```text
   logs/agentcom-real-integration-2026-06-05T04-23-00-492Z.jsonl
   ```

   根因：`agentcom-test` 尚未部署或当前 workers.dev 目标没有最新 Worker。

2. 部署测试 Worker：

   ```bash
   npx wrangler deploy --config server/agentcom/wrangler.test.toml
   ```

   部署成功，输出包含：

   ```text
   Uploaded agentcom-test
   Deployed agentcom-test triggers
   https://agentcom-test.swulling.workers.dev
   Current Version ID: 27a675de-8ea4-4136-b34d-1b010d5e4df5
   ```

3. 第二次真实集成测试通过：

   ```text
   PASS real integration test against https://agentcom-test.swulling.workers.dev
   Log: /Users/yangtao04/src/github/ninehills/agentcom/logs/agentcom-real-integration-2026-06-05T04-23-32-718Z.jsonl
   ```

4. 清理脚本后又发现一次脚本自身问题：`send` 步骤偶发超时。日志：

   ```text
   logs/agentcom-real-integration-2026-06-05T04-24-20-412Z.jsonl
   ```

   根因：测试脚本使用一次性 `message` listener，Bob 的 `message` 可能早于等待 ACK 的代码到达，导致消息被 listener 竞争丢失。

   修复：脚本改为每个 WebSocket 使用独立消息队列和 waiter 队列，早到消息进入 queue，不再丢失。

5. 修复后最终真实集成测试通过：

   ```bash
   npm run test:integration:real
   ```

   结果：

   ```text
   PASS real integration test against https://agentcom-test.swulling.workers.dev
   Log: /Users/yangtao04/src/github/ninehills/agentcom/logs/agentcom-real-integration-2026-06-05T04-25-23-179Z.jsonl
   ```

6. 最后再次运行本地验证，已通过：

   ```bash
   npm test
   npm run typecheck
   ```

## 配置现状

Wrangler 配置已按用户要求拆分：

- `server/agentcom/wrangler.test.toml`：提交到 Git，部署 `agentcom-test`。
- `server/agentcom/wrangler.toml`：本地生产配置，已被 `server/agentcom/.gitignore` 忽略，不提交。

测试配置包含：

- `name = "agentcom-test"`
- `AGENTCOM_TEST_ACCESS_EMAIL = "tester@example.com"`
- `DEVICE_TOKEN_HMAC_SECRET = "test-secret"`

测试配置里的 `AGENTCOM_TEST_ACCESS_EMAIL` 和 `test-secret` 只允许测试环境使用。

生产配置要求：

- `name = "agentcom"`
- `TEAM_DOMAIN = "https://ninehills.cloudflareaccess.com"`
- `POLICY_AUD = "<生产 Access Application Audience AUD Tag>"`
- 不包含 `AGENTCOM_TEST_ACCESS_EMAIL`
- 不包含明文 `DEVICE_TOKEN_HMAC_SECRET`

注意：生产 `DEVICE_TOKEN_HMAC_SECRET` 不写进配置文件，用 `wrangler secret put` 设置。用户之前贴过一次 secret，已建议重新生成，不应复用聊天中出现过的 secret。

## Cloudflare Access 决策

最终采用的 Access 配置不是保护整个 `workers.dev`，而是只保护：

```text
agentcom.swulling.workers.dev/auth/
```

如果 UI 拆字段：

```text
Domain: agentcom.swulling.workers.dev
Path: /auth/*
```

这样 `/auth/*` 走 Access，`/ws` 保持公开，由 agentcom 自己的 device token / 设备签名鉴权保护。这个决策已经写进 `server/agentcom/README.md`。

## 最近用户关注点

1. 用户反馈 `/auth/devices` 页面太空，已经做了视觉改造。
2. 用户随后反馈设备列表仍缺少 hostname 等信息，已改为展示 nodeName、hostname、deviceId、nodeId、email、created/last seen/revoked 信息，并补了测试。
3. 用户要求把所有提交压缩到一个 commit，之前已完成。
4. 用户要求对 `agentcom-test.swulling.workers.dev` 做真实测试，本轮已补真实集成测试脚本、部署测试 Worker、运行完整真实集成测试并记录日志。
5. 用户要求从开发者角度重写 `server/agentcom/README.md`，本轮已完成。
6. 用户要求更新本交接文档，然后整体 commit and push。

## 下一会话建议

如果继续排查线上生产环境，先访问：

```text
https://agentcom.swulling.workers.dev/auth/devices
```

确认页面 HTML 是否包含 hostname。如果不包含，优先检查：

1. 线上是否部署最新代码；
2. 浏览器缓存或 Access 登录会话；
3. 设备是否由包含 hostname 字段的新客户端注册；
4. `/ws` 是否仍返回 `426 Expected Upgrade: websocket` 而不是被 Access 拦截。

可先在测试环境复现：

```bash
npx wrangler deploy --config server/agentcom/wrangler.test.toml
npm run test:integration:real
```

## 建议下一会话使用的技能

- `workers-best-practices`：继续改 Worker 代码或 Wrangler 配置时使用。
- `durable-objects`：继续改 ComRoom Durable Object 状态或 WebSocket 行为时使用。
- `wrangler`：部署、secret、tail、dry-run 时使用。
- `design`：继续打磨 `/auth/devices` 或 `/auth/device` 页面时使用。
- `hunt`：如果线上行为与代码不一致，先复现并定位根因。
