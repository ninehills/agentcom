# agentcom 总体设计

## 版本

- **版本**: 2.0
- **日期**: 2026-06-05
- **状态**: 待审查
- **参考 PRD**: `docs/prd/agentcom.md`
- **子文档**:
  - [协议设计](protocol.md) — 类型、消息、地址解析
  - [Worker 设计](worker.md) — Cloudflare Worker + ComRoom DO
  - [Pi 插件设计](pi-agentcom.md) — RemoteComClient + 调用链

---

## 1. 总体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Cloudflare                                    │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  agentcom Worker (workers.dev)                                │   │
│  │                                                               │   │
│  │  GET /auth/device  → Access 保护 → 生成 device token (HTML)   │   │
│  │  GET /auth/devices → Access 保护 → 设备管理页                 │   │
│  │  POST /auth/revoke → Access 保护 → 撤销设备                   │   │
│  │  GET /ws      → 公开入口 → Durable Object: ComRoom            │   │
│  │                                                               │   │
│  │  ComRoom DO:                                                  │   │
│  │    - sessions Map (在线 WS 连接)                              │   │
│  │    - devices Map (publicKey, email)  ← SQLite 持久化          │   │
│  │    - deviceTokens Map (HMAC hash, 5min TTL) ← SQLite          │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
└─────────────────────────────┼───────────────────────────────────────┘
                              │ wss:// (公开) / https:// (Access)
      ┌───────────────────────┼───────────────────────────────────────┐
      │  Machine A            │          Machine B                    │
      │  ┌────────────────┐   │   ┌────────────────┐                 │
      │  │ pi-agentcom    │   │   │ pi-agentcom    │                 │
      │  │  /com join ...  │   │   │  /com join ... │                 │
      │  │  com() tool     │   │   │  com() tool     │                 │
      │  └───────┬────────┘   │   └────────────────┘                 │
      │          │            │                                       │
      │  ┌───────┴────────┐   │                                       │
      │  │ RemoteComClient │   │                                       │
      │  │  WebSocket      │   │                                       │
      │  │  签名挑战       │   │                                       │
      │  └────────────────┘   │                                       │
      │                       │                                       │
      │  ~/.config/agentcom/  │                                       │
      │    config.json        │                                       │
      │    credentials.json   │                                       │
      └───────────────────────┘                                       │
```

### 组件关系

```
packages/protocol (共享类型 + 地址解析)
    ↑
packages/client (RemoteComClient + 配置 + 凭证 + 密钥)
    ↑
pi-agentcom (Pi 插件: /com 命令 + com tool + 面板 UI)
    │
    │ wss:// (WebSocket 通信)
    ↓
server/agentcom (单 Worker + DO ComRoom)
    │
    ├── /ws            → WebSocket upgrade → DO（公开, 设备签名鉴权）
    └── /auth/*        → HTTP → Cloudflare Access JWT 校验 → DO
```

**三层鉴权**：

| 层级 | 对象 | 方式 | 有效期 |
|------|------|------|--------|
| 谁能在页面上获取 token | 人类用户 | Cloudflare Access + Cloudflare 账号 | 按会话 |
| 谁能拿着 token 注册设备 | 新设备 | HMAC 验证 /auth/device 生成的 token | 5 分钟 / 单次 |
| 谁能长期连接 room | 已注册设备 | challenge-response (P-256 ECDSA 签名) | 永久 / 直到撤销 |

---

## 2. 项目结构

```
agentcom/
  README.md
  package.json
  pnpm-workspace.yaml

  server/
    agentcom/           # Cloudflare Worker + ComRoom DO
      src/
        index.ts        # Worker 入口: 路由 /ws /auth/device /auth/devices /auth/revoke
        room.ts         # ComRoom DO: sessions + auth + messaging
      wrangler.toml
      package.json

  packages/
    protocol/           # @agentcom/protocol
      src/
        types.ts        # NodeInfo, SessionInfo, Message, Attachment
        messages.ts     # AuthMessage, ClientMessage, ServerMessage
        address.ts      # parseAddress, resolveTarget

    client/             # @agentcom/client
      src/
        com-client.ts   # RemoteComClient (WebSocket + 签名)
        credentials.ts  # 凭证读/写 ~/.config/agentcom/credentials.json
        config.ts       # 配置读/写 ~/.config/agentcom/config.json
        crypto.ts       # P-256 keypair 生成 + 签名

    pi-agentcom/        # @agentcom/pi
      src/
        index.ts        # Pi extension 入口: /com 命令 + com tool
        commands/
          com-command.ts # 子命令处理 (join/auth/send/ask/reply/...)
        ui/
          session-list.ts # 面板: 节点→cwd→runtime 三级分组
          compose.ts      # 消息草稿 (复用 pi-intercom)
          inline-message.ts # 内联消息渲染 (复用 pi-intercom)
      package.json

    claude-agentcom/    # 预留: Claude Code 适配
    codex-agentcom/     # 预留: Codex 适配

  docs/
    prd/agentcom.md
    design/
      agentcom.md       # 本文件
      protocol.md
      worker.md
      pi-agentcom.md
```

### 共享配置 (`~/.config/agentcom/`)

| 文件 | 内容 | 权限 |
|------|------|------|
| `config.json` | serverUrl, authUrl（Worker 基础 URL，不含 `/auth/device` 路径）, autoJoin, confirmSend, replyHint | 0644 |
| `credentials.json` | 按 serverUrl 保存 credential；每项包含 deviceId, nodeId, nodeName, privateKeyJwk | 0600 |
| `nodes.json` | preferredNodeName, lastServer (可选) | 0644 |

---

## 3. 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 单 Worker 还是双 Worker | **单 Worker** | `/ws` 可绕过 Access 公开（CLI 无法做浏览器 SSO），`/auth/*` 统一由 Access 保护，便于配置 |
| 传输层 | **WebSocket** | 双工、浏览器/Node.js 原生支持、Cloudflare DO 直接 `acceptWebSocket()` |
| 认证模式 | **三层链式** | Access 控制入口资格 → device token 控制设备注册 → 签名控制日常连接 |
| Token 安全 | **HMAC 哈希存储** | 服务端不存明文 token，泄露 DO 存储也无法伪造新 token |
| 签名算法 | **P-256 ECDSA** | Web Crypto 原生支持，JWK 格式便于存储和传输 |
| 地址格式 | **session-name@node-name** | 跨机器必须区分节点，"@" 语义直观 |
| Session name | **运行时别名，默认值由服务端分配** | 与 Pi session title 解耦；客户端未提供名称时，服务端生成 session id 后把 name 设为该 id（`s-xxxxxxxx`） |
| UI 面板结构 | **节点→cwd→runtime** | 三级分组便于跨机器多 session 场景导航 |
| 离线消息 | **不保证送达** | 发送有 ACK 和超时，保证发送方知道结果 |
| 配置路径 | **~/.config/agentcom/** | XDG 规范，多扩展共享 |

---

## 4. 错误处理总览

### 4.1 重连策略（客户端）

```
断开检测: ws.onclose / ws.onerror
重连延迟: 1s → 2s → 5s → 10s → 30s (指数退避, 最大 30s)
重连成功: reconnectAttempt 重置为 0
断开期间: replyWaiter reject, pendingSends/Lists failPending
```

对标 pi-intercom 的 `getReconnectDelayMs()` + `scheduleReconnect()`。

### 4.2 超时

| 操作 | 超时 | 行为 |
|------|------|------|
| WebSocket 连接建立 | 10s | reject |
| listSessions | 5s | reject |
| send (ACK 等待) | 10s | reject (或返回 delivery_failed) |
| ask (等待回复) | 10min | reject |
| device token 有效期 | 5min | DO storage 自动过期 |

### 4.3 边界情况

| 场景 | 处理 |
|------|------|
| 发送方在等待 ACK 时断开 | pendingSends 被 failPending cleanup |
| 目标 session 在消息到达前断开 | DO 返回 `delivery_failed: "Target disconnected"` |
| hostname 冲突 | DO 自动添加 4 位随机后缀 |
| token 过期 | DO 返回 `register_failed: "Invalid or expired device token"` |
| device 被撤销 | DO 拒绝 auth，返回 `auth_failed`；客户端提示重新认证，但不自动删除本地 credential |
| DO 冷启动 | 首次 WebSocket 请求唤醒 DO，从 SQLite 恢复持久化状态 |

---

## 5. 与 pi-intercom 的差异

| 维度 | pi-intercom | agentcom |
|------|-------------|----------|
| 传输 | Unix socket / TCP (localhost) | WebSocket (Cloudflare) |
| 服务端 | 本地 broker 进程 (`spawnBrokerIfNeeded`) | 无服务端进程 (Cloudflare DO) |
| 消息格式 | 4-byte length-prefixed JSON frames | WebSocket JSON |
| 认证 | 无 (信任本机) | 三层链式 (Access → token → 签名) |
| 寻址 | session name / sessionId | `session-name@node-name` |
| 节点 | 无 | node: hostname → nodeName |
| 配置 | `~/.pi/agent/intercom/config.json` | `~/.config/agentcom/config.json` |
| 命令 | `/intercom` | `/com` (统一入口) |
| Tool 名 | `intercom` | `com` |
| 跨机器 | 否 | 是 |
| 运行时标识 | 无 | `runtime` 字段 (pi/codex/claude) |
| Session 别名 | `subagent-chat-xxx` | agentcom 未命名时由服务端默认成 session id（`s-xxxxxxxx`） |
| ReplyTracker | ✓ | 复用 |
| UI 面板结构 | 扁平列表 | 节点→cwd→runtime 三级 |

---

## 6. 用户流程

```
首次加入:
  1. /com auth                                         # 打开 ${authUrl}/auth/device（未配置则交互式输入 Worker 基础 URL 并保存）
  2. 浏览器登录 Cloudflare                               # Access 拦截
  3. 页面生成 device token + 完整 join 命令               # com_dev_xxxxx
  4. /com join wss://agentcom.xxx.workers.dev/ws com_dev_xxxxx  # 注册设备
  5. /com                                               # 打开面板

日常使用:
  1. 启动 pi → 自动读取 credentials.json → 签名重连        # 无需手动操作
  2. /com                                               # 面板
  3. /com send main@macbook-pro "hello"                  # 发消息
  4. /com list                                          # 列表

管理:
  /com rename devbox                                    # 改名
  /com device                                           # 打开设备管理页，在页面上撤销设备
```
