# agentcom 产品需求文档

## 版本

- **版本**: 2.0
- **日期**: 2026-06-05
- **状态**: 待审查
- **作者**: pi agent + 用户协作

---

## 1. 问题陈述

**我们要解决什么问题？**

当前 coding agent（pi、Claude Code 等）只能在本地多 session 之间通信，无法跨机器。当用户在不同设备上运行 agent 时（例如笔记本、台式机、远程服务器），这些 session 之间不能互相发现、发送消息或请求帮助，极大限制了多 agent 协作场景。

**为谁解决？**

在多个物理/虚拟机器上并发使用 coding agent 的开发者。典型场景包括：
- 一台 MacBook 上的 agent session 需要向远程 Linux 开发服务器上的 session 发送命令或寻求帮助
- 多个子 agent 分布在不同机器上，需要一个统一的房间来协调
- 团队成员之间需要跨机器的 agent 通信（同一 Cloudflare 账号下的信任域）

---

## 2. 目标用户

### 主要用户画像

- **个人开发者（多机器）**: 在 2-5 台设备上运行 pi agent，需要在它们之间发送消息、传递上下文、请求决策
- **小团队协作者**: 同一 Cloudflare 账号下的 2-10 人，各自在不同机器上，需要 room 内 agent 间通信

### 用户特征

- 熟悉命令行和终端工具
- 已有或愿意注册 Cloudflare 账号
- 了解基本的 WebSocket 和网络概念
- 需要简单、安全的跨机器通信方案，不想维护复杂的基础设施

---

## 3. 用户故事

| # | 用户故事 |
|---|---------|
| US-01 | 作为多机器开发者，我希望在笔记本上执行 `/com join` 即可加入一个 room，以便自动发现其他机器上的 pi session |
| US-02 | 作为 room 内任一用户，我希望用 `/com list` 查看所有在线 session 及其节点名，以便知道可以和谁通信 |
| US-03 | 作为 room 内成员，我希望用 `/com send <session@node> <message>` 向特定 session 发送消息，以便传递任务或上下文 |
| US-04 | 作为 room 内成员，我希望用 `/com ask <session@node> <message>` 发送消息并等待回复，以便获取其他 session 的决策或帮助 |
| US-05 | 作为接收消息的用户，我希望看到 `com({ action: "reply", message: "..." })` 的提示，以便快速回复 |
| US-06 | 作为首次加入的用户，我希望通过网页登录 Cloudflare 账号获取一次性 device token，然后用该 token 注册设备，以后无需重复登录 |
| US-07 | 作为已注册设备用户，我希望重启 pi 后自动重连到上次的 room，无需手动输入任何凭证 |
| US-08 | 作为用户，我希望能查看并撤销自己邮箱注册的设备，以便移除不再可信或不再使用的机器 |
| US-09 | 作为用户，我希望能用 `/com rename` 给我的节点起一个有意义的名称，以便其他人知道这台机器是谁的 |
| US-10 | 作为 agent（模型），我希望能调用 `com` 工具向 room 内其他 session 发送消息、请求帮助或协调子 agent |

---

## 4. 功能需求

### 4.1 房间与连接

| ID | 需求 | 优先级 |
|----|------|--------|
| F-01 | 单个 Cloudflare Durable Object 实例 = 一个 room，全部在线 session 共享同一个房间 | P0 |
| F-02 | 服务端由单个 Cloudflare Worker（`agentcom`）承载：`/ws` 为公开 WebSocket 入口（设备签名鉴权），`/auth/device` 等路由受 Cloudflare Access 保护（网页登录生成 device token） | P0 |
| F-03 | Access 按路径策略配置：`/auth/*` 保护，`/ws` 公开 | P0 |
| F-04 | 客户端通过 `/com join <ws_url> <device_token>` 首次注册设备 | P0 |
| F-05 | 首次注册时，客户端先生成 P-256 keypair 并提交 publicKey；注册成功后服务端返回 deviceId、nodeId、nodeName，并保存 publicKey | P0 |
| F-06 | 后续连接走 auth_begin(deviceId) → auth_challenge(nonce) → auth_finish(signature) 的挑战-应答流程 | P0 |
| F-07 | 客户端重启时自动读取本地 credential 并重连（支持 autoJoin 配置） | P0 |
| F-08 | 所有扩展共享同一配置目录 `~/.config/agentcom/`，包含 config.json 和 credentials.json | P1 |

### 4.2 命名与寻址

| ID | 需求 | 优先级 |
|----|------|--------|
| F-09 | 地址格式统一为 `session-name@node-name`（例如 `main@macbook-pro`、`backend@devbox-jp`） | P0 |
| F-10 | session-name 为运行时别名，与 Pi session title 不同步；未命名 session 由服务端在生成 session id 后默认命名为该 id（形如 `s-1a2b3c4d`），确保始终可寻址 | P0 |
| F-11 | 发送消息时按 `session-name@node-name` 精确匹配；session 名在全 room 唯一时可省略 node 名；若名称匹配多个 session，则返回错误并提示使用 session id | P1 |
| F-12 | 默认 node-name = hostname；hostname 冲突时自动分配 `hostname-<随机4位后缀>` | P0 |
| F-13 | `/com rename <node_name>` 仅修改当前节点展示名（不涉及 session name；session name 由各自运行时的 `/name` 等命令修改）；目标名冲突时返回自动分配后的名称；改名不广播，只影响后续列表和目标选择 | P1 |
| F-14 | 面板列表按节点分组，节点下按目录（cwd）分组，再按运行时代理（pi/codex/claude 等）展示 session | P1 |

### 4.3 消息通信

| ID | 需求 | 优先级 |
|----|------|--------|
| F-15 | `/com`（无参数）打开 session 列表面板，按 节点 → 目录 → 运行时 层级展示，选择目标后发送消息 | P0 |
| F-16 | `/com list` 在终端文本列出全部节点的全部在线 session | P0 |
| F-17 | `/com send <session@node> <message>` 发送消息；客户端先把用户输入的 `session@node` 解析为唯一 session id，底层协议只发送 `{ to: sessionId, message }`；服务端返回 ACK，发送失败或超时返回明确错误 | P0 |
| F-18 | `/com ask <session@node> <message>` 发送消息并等待回复；目标解析规则同 F-17，超时返回错误 | P0 |
| F-19 | `/com reply <message>` 回复最近一次 pending ask | P0 |
| F-20 | `/com pending` 列出待回复消息 | P1 |
| F-21 | 消息支持文本和附件（file/snippet/context） | P1 |
| F-22 | agent 模型通过 `com` tool 向 room 内其他 session 发送消息（list/send/ask/reply/pending/status），所有发送均有 ACK | P0 |

### 4.4 认证与安全

| ID | 需求 | 优先级 |
|----|------|--------|
| F-23 | `/com auth` 打开认证页面获取 device token：读取 `config.json` 中配置的 authUrl（Worker 基础 URL，例如 `https://agentcom.example.workers.dev`）并打开 `${authUrl}/auth/device`；未配置则交互式提示用户输入 Worker 基础 URL，保存为 authUrl 后再打开认证页面 | P0 |
| F-24 | Cloudflare Access 策略限制为 Cloudflare Account Member（仅同账号成员可访问认证页） | P0 |
| F-25 | Device token 有效期 5 分钟，一次性使用，使用后立即失效 | P0 |
| F-26 | 本机私钥存储在 `~/.config/agentcom/credentials.json`，权限为 `0600` | P0 |
| F-27 | 服务端仅存储 publicKey，不存储任何可用于伪造设备连接的私密材料 | P0 |
| F-28 | `/com device` 打开设备管理页，用户可在页面上查看并撤销当前登录邮箱注册的设备 | P1 |
| F-29 | 设备管理页支持撤销当前登录邮箱对应的指定设备，撤销后该设备无法再连接；客户端不自动删除本地 credential，需用户执行 `/com leave` 清理 | P1 |
| F-30 | `/com leave` 本机退出当前 room，并删除 `credentials.json` 中当前 server URL 对应的 credential；保留其他 server 的 credential | P1 |

### 4.5 状态与诊断

| ID | 需求 | 优先级 |
|----|------|--------|
| F-31 | `/com status` 显示当前连接状态：server URL、node 名、session 名、在线 session 数 | P1 |
| F-32 | 服务端维护 session 的 presence（name、status、model、lastActivity、runtime） | P1 |
| F-33 | session 断开时自动向 room 内其他成员广播 session_left | P1 |

---

## 5. 非功能需求

### 5.1 性能

| ID | 需求 |
|----|------|
| NF-01 | 消息传递延迟应在 WebSocket 网络延迟 + 100ms 以内（正常情况下 < 500ms）；发送均有 ACK，超时（默认 30s）返回错误 |
| NF-02 | 单个 room 支持 2-50 个并发 session |
| NF-03 | Durable Object 应使用 WebSocket Hibernation 降低计费 duration |

### 5.2 可靠性

| ID | 需求 |
|----|------|
| NF-04 | WebSocket 断线后客户端应自动重连（指数退避，最大间隔 30s） |
| NF-05 | 服务端 session 意外断开时应在 5s 内检测并广播离开事件 |
| NF-06 | Device token 过期后提示用户重新访问 `/com auth` 获取新 token |

### 5.3 安全性

| ID | 需求 |
|----|------|
| NF-07 | 所有 WebSocket 通信使用 `wss://`（TLS 加密） |
| NF-08 | 私钥仅存于客户端，服务端不持久存储任何可推导私钥的材料 |
| NF-09 | Device token 使用 HMAC 哈希存储，不使用明文 |
| NF-10 | Credentials.json 文件权限为 `0600`，拒绝其他用户读取 |

### 5.4 兼容性

| ID | 需求 |
|----|------|
| NF-11 | 支持 Node.js 18+（Pi agent 运行环境） |
| NF-12 | 后续设计需能扩展支持 Claude Code、Codex 等其他 agent 平台 |
| NF-13 | 配置目录遵循 XDG 规范：优先 `AGENTCOM_CONFIG_HOME`，其次 `XDG_CONFIG_HOME/agentcom`，最后 `~/.config/agentcom` |

### 5.5 可用性

| ID | 需求 |
|----|------|
| NF-14 | 首次加入 room 的总步骤不超过 3 步：`/com auth` 打开 auth 页 → 登录 → 粘贴页面生成的 join 命令 |
| NF-15 | 重连完全自动，用户无需任何操作 |
| NF-16 | 命令帮助信息内置在 `/com` 无参数输出中 |

---

## 6. 验收标准

### 房间与连接

- [ ] AC-01: 在两个不同机器上分别执行 `/com join` 加入同一 room，执行 `/com list` 可看到对方 session
- [ ] AC-02: 关闭客户端进程，重启后自动重连到上次的 room
- [ ] AC-03: 使用无效 device token 或过期 token join 时，返回明确错误提示

### 消息通信

- [ ] AC-04: `/com send main@macbook-pro "hello"` 后，目标 session 收到消息
- [ ] AC-05: `/com ask architect@devbox "review this"` 后，目标 session 收到 ask 并可在发送方看到 pending 状态
- [ ] AC-06: 目标 session 执行 `/com reply "approved"` 后，原发送方收到回复
- [ ] AC-07: agent 模型调用 `com({ action: "send", to: "main@macbook-pro", message: "..." })` 成功送达

### 认证与安全

- [ ] AC-08: 未登录 Cloudflare 账号访问 `/auth/device` 页面时被 Cloudflare Access 拦截
- [ ] AC-09: 使用同一 device token 注册两次，第二次被拒绝
- [ ] AC-10: 在设备管理页撤销当前登录邮箱注册的设备后，该设备无法再连接 room，且本地 credentials.json 中对应 server URL 的 credential 保留到用户执行 `/com leave`
- [ ] AC-11: 伪造的 deviceId（无对应私钥）无法通过 auth_challenge 验证

### 命名与寻址

- [ ] AC-12: hostname 冲突时新节点自动获得带后缀的名称（如 `macbook-pro-a7f3`）
- [ ] AC-13: `/com rename devbox` 后，后续列表/目标选择使用新节点名，其他 session 通过 `xxx@devbox` 可发送消息到此节点

---

## 7. 成功指标

| 指标 | 目标值 | 衡量方式 |
|------|--------|---------|
| 首次加入耗时 | < 2 分钟 | 用户从无到可发送第一条消息的时间 |
| 重连成功率 | > 99% | 进程重启后 30s 内自动恢复连接的比例 |
| 消息送达率 | > 99.9% | 已发送消息被目标成功接收的比例 |
| Room 内 session 上限 | 50 | 实测可稳定维持的并发 session 数 |
| 跨平台兼容 | Pi / Claude / Codex | 至少有两个 agent 平台的适配实现 |

---

## 8. 不在范围内

以下功能明确不在第一阶段实现范围内：

| 范围外 | 说明 |
|--------|------|
| 多 room 支持 | 第一版一个 Cloudflare 部署 = 一个 room，不做 room_name 路由 |
| 离线消息 | 接收方离线时消息不缓存；发送有 ACK，超时或发送失败返回错误 |
| 二进制文件传输 | 附件支持文本类内容（snippet/context），不支持二进制文件传输 |

---

## 9. 项目结构

```
agentcom/
  README.md
  package.json
  pnpm-workspace.yaml

  server/
    agentcom/            # Cloudflare Worker + ComRoom DO
      src/
        index.ts         # Worker 入口：路由 /ws /auth/device /auth/devices /auth/revoke
        room.ts          # ComRoom DO：sessions + auth + messaging
      wrangler.toml
      package.json

  packages/
    protocol/            # 共享协议类型 + 地址解析
      src/
        types.ts
        messages.ts
        address.ts
      package.json
    client/              # 通用 WebSocket 客户端 + 认证 + 配置
      src/
        com-client.ts
        credentials.ts
        config.ts
        crypto.ts
      package.json
    pi-agentcom/        # Pi 插件（/com 命令 + com tool + 面板）
      src/
        index.ts
        commands/
        ui/
      package.json
    claude-agentcom/    # 预留：Claude Code 适配
    codex-agentcom/     # 预留：Codex 适配
    cli/                 # 可选：独立 CLI 工具

  scripts/
    setup-access.ts      # Cloudflare Access 自动配置脚本（可选）

  docs/
    prd/
      agentcom.md        # 本文件
```

### 共享配置

所有扩展统一读写 `~/.config/agentcom/`：

- `config.json`: 默认 serverUrl、authUrl（Worker 基础 URL，不含 `/auth/device` 路径）、autoJoin、confirmSend 等
- `credentials.json` (0600): 按 server URL 保存 credential；每项包含 deviceId、nodeId、nodeName、privateKeyJwk
- `nodes.json` (可选): 本地偏好节点名

### 包命名

- `@agentcom/protocol`
- `@agentcom/client`
- `@agentcom/pi`
- `@agentcom/cli`

---

## 10. 部署配置（手动）

### 10.1 部署 Worker

```bash
cd server/agentcom
pnpm install
# 设置 HMAC secret（用于 device token 哈希）
openssl rand -base64 32 | pnpm wrangler secret put DEVICE_TOKEN_HMAC_SECRET
pnpm wrangler deploy
# 得到: https://agentcom.<subdomain>.workers.dev
```

### 10.2 开启 Cloudflare Access

在 Cloudflare Dashboard 中：
1. **Zero Trust** → **Access** → **Applications** → **Add Application**
   - Type: **Self-hosted**
   - Application name: `agentcom`
   - Domain: `agentcom.<subdomain>.workers.dev`
   - Path: `/auth/*`
2. Identity provider: **Cloudflare**
3. Policy: **Allow** → Include **Cloudflare Account Member**
4. `/ws` 路径不在 Access Application 中，保持公开入口

### 10.3 用户首次使用流程

1. 本地执行 `/com auth`（读取已配置的 authUrl；若未配置则交互式输入 Worker 基础 URL 并保存）
2. 终端打印 `${authUrl}/auth/device`，用户点击在浏览器中打开
3. 浏览器中登录 Cloudflare 账号
4. 认证页面生成 device token 和完整的 join 命令（包含 ws_url + device_token）
5. 用户复制 join 命令到终端执行: `/com join wss://agentcom.<subdomain>.workers.dev/ws com_dev_xxxxxxxxxxxxx`
6. 以后直接 `/com` 打开面板即可，重启后自动重连

---

## 11. 命令参考

| 命令 | 说明 |
|------|------|
| `/com` | 打开通信面板，列出所有 session 并选择发送消息 |
| `/com auth` | 打开 `${authUrl}/auth/device` 获取 device token；未配置 authUrl 时交互式输入 Worker 基础 URL 并保存 |
| `/com join <ws_url> <device_token>` | 注册设备并加入 room |
| `/com list` | 文本列出所有在线 session |
| `/com send <session@node> <message>` | 发送消息 |
| `/com ask <session@node> <message>` | 发送消息并等待回复 |
| `/com reply <message>` | 回复最近一次 pending ask |
| `/com pending` | 列出待回复消息 |
| `/com rename <node_name>` | 修改当前节点展示名 |
| `/com device` | 打开设备管理页，查看并撤销当前登录邮箱注册的设备 |
| `/com status` | 查看当前连接状态 |
| `/com leave` | 离开 room 并清除本地凭证 |
