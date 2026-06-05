# agentcom Pi 插件设计

## 版本

- **版本**: 1.0
- **日期**: 2026-06-05
- **父文档**: [总体设计](agentcom.md)

---

## 1. 设计边界

本文描述 Pi 插件的模块职责、接口和调用链路，不保留具体实现代码。

Pi 插件职责：

- 管理本地配置与凭证。
- 在 session 启动时自动连接当前 `config.serverUrl`。
- 提供 `/com` 命令与 `com` tool。
- 在发送前把用户输入的目标解析为 session id。
- 接收远端消息并注入 Pi 对话/UI。

---

## 2. 组件概览

```
pi-agentcom/src/
  index.ts              # Pi extension 入口
  commands/com-command  # /com 子命令处理
  ui/session-list       # 节点 → cwd → runtime 三级列表
  ui/compose            # 消息草稿界面
  ui/inline-message     # 收到消息后的内联渲染
  reply-tracker         # ask/reply 追踪

packages/client
  RemoteComClient       # WebSocket、认证、list/send/presence
  config                # ~/.config/agentcom/config.json
  credentials           # ~/.config/agentcom/credentials.json
  crypto                # P-256 keypair 与签名

packages/protocol
  SessionInfo / Message
  parseAddress / resolveTarget
```

与 pi-intercom 的主要差异：

| 维度 | pi-intercom | agentcom |
|------|-------------|----------|
| 传输 | 本机 socket | WebSocket |
| 认证 | 信任本机 | device token + 设备签名 |
| 寻址 | session name / id | `session-name@node-name`，发送前解析为 session id |
| 面板 | 扁平 session 列表 | 节点 → cwd → runtime 三级列表 |

---

## 3. RemoteComClient 接口

保留接口定义，具体实现放到代码中。

```ts
export interface ConnectOptions {
  deviceToken?: string;
  deviceId?: string;
  privateKeyJwk?: JsonWebKey;
  hostname?: string;
  preferredNodeName?: string;
  publicKeyJwk?: JsonWebKey;
  session: SessionRegistration;
}

export interface RemoteComClient {
  sessionId: string | null;
  nodeId: string | null;
  nodeName: string | null;

  connect(options: ConnectOptions): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;

  listSessions(): Promise<SessionInfo[]>;
  send(toSessionId: string, options: SendOptions): Promise<SendResult>;
  updatePresence(updates: PresenceUpdates): void;
  renameNode(nodeName: string): Promise<void>;
}
```

核心调用链：

```
首次注册 connect(deviceToken):
  → 打开 WebSocket
  → 发送 register_device
  → 收到 register_ok
  → 保存 sessionId/nodeId/nodeName

后续重连 connect(deviceId + privateKey):
  → 打开 WebSocket
  → auth_begin
  → auth_challenge
  → 本地私钥签名 nonce
  → auth_finish
  → register_ok

send(toSessionId):
  → 要求已连接
  → 组装 Message
  → 发送 send(to: sessionId, message)
  → 等待 delivered / delivery_failed

listSessions():
  → 发送 list(requestId)
  → 等待 sessions(requestId)
```

---

## 4. 启动连接调用链

```
Pi session_start
  → loadConfig()
  → 如果 config.enabled == false，停止
  → 只读取 config.serverUrl 对应的 credential
  → 如果 credential 存在:
      - buildRegistration()
      - RemoteComClient.connect(deviceId + privateKey)
      - attach incoming/disconnect handlers
  → 如果 credential 不存在:
      - 不自动选择其他 server credential
      - 等待用户执行 /com join
```

`buildRegistration()` 规则：

| 字段 | 来源 |
|------|------|
| `name` | 当前运行时别名；若没有则不传/传空，由服务端默认成 session id |
| `cwd` | 当前工作目录 |
| `model` | 当前模型 id，未知则 `unknown` |
| `runtime` | `pi` |
| `pid` | 当前进程 id |
| `startedAt` | 当前 session 启动时间 |
| `lastActivity` | 当前时间 |
| `status` | 初始为 `idle` |

---

## 5. `/com` 命令调用链

| 子命令 | 行为 |
|--------|------|
| `/com` | 打开 session 面板，选择目标后发送消息 |
| `/com auth` | 打开 `${authUrl}/auth/device`，未配置 authUrl 时交互式输入 Worker 基础 URL |
| `/com join <ws_url> <device_token>` | 首次注册设备并保存当前 server credential |
| `/com list` | 列出在线 session |
| `/com send <target> <message>` | 解析 target → sessionId，然后发送 |
| `/com ask <target> <message>` | 解析 target → sessionId，发送并等待回复 |
| `/com reply <message>` | 回复最近 pending ask |
| `/com pending` | 列出待回复 ask |
| `/com rename <node_name>` | 修改当前节点展示名 |
| `/com device` | 打开 `${authUrl}/auth/devices` |
| `/com status` | 显示连接状态 |
| `/com leave` | 断开连接并删除当前 server credential |

### 5.1 `/com auth`

```
handleAuth
  → 读取 config.authUrl
  → 如果为空，提示用户输入 Worker 基础 URL
  → normalizeAuthBaseUrl
  → 保存 config.authUrl
  → 打印/打开 authUrl + "/auth/device"
```

约束：

- `/com auth` 不接受 URL 参数。
- `authUrl` 保存 Worker 基础 URL，不包含 `/auth/device`。
- 其他依赖 `authUrl` 的命令不重复输入逻辑；缺失时提示先执行 `/com auth`。

### 5.2 `/com join`

```
handleJoin(wsUrl, deviceToken)
  → 如果当前 client 已连接，先断开
  → config.serverUrl = wsUrl
  → 生成本地 P-256 keypair
  → connect(deviceToken + publicKey + session registration)
  → 收到 register_ok
  → 保存 credentials[wsUrl]
  → 提示 joined node/session
```

### 5.3 `/com send`

```
handleSend(target, text)
  → ensureConnected
  → sessions = listSessions()
  → resolved = resolveTarget(sessions, target)
  → 如果 resolved 失败，展示 reason
  → client.send(resolved.sessionId, text)
  → 展示 delivered / delivery_failed
```

### 5.4 `/com ask` / `/com reply`

```
ask:
  → resolve target
  → 发送 expectsReply: true
  → ReplyTracker 记录等待项
  → 等待对方 reply 或超时

reply:
  → ReplyTracker 选择最近 pending ask
  → client.send(ctx.from.id, replyTo: originalMessage.id)
  → 标记已回复
```

### 5.5 `/com device`

```
handleDevice
  → 如果 config.authUrl 为空，提示先 /com auth
  → 打开 authUrl + "/auth/devices"
```

约束：CLI 不提供 revoke 子命令；撤销只在浏览器设备管理页完成。

### 5.6 `/com leave`

```
handleLeave
  → disconnect
  → removeCredential(config.serverUrl)
  → 保留其他 server credential
```

---

## 6. com tool 接口

```ts
export interface ComToolParams {
  action: "list" | "send" | "ask" | "reply" | "pending" | "status";
  to?: string;
  message?: string;
  attachments?: Attachment[];
  replyTo?: string;
}
```

tool 行为：

| action | 行为 |
|--------|------|
| `list` | 返回在线 sessions |
| `send` | 解析 `to` → sessionId，然后发送 |
| `ask` | 解析 `to` → sessionId，发送并等待 reply |
| `reply` | 回复 pending ask |
| `pending` | 列出 pending asks |
| `status` | 返回连接状态 |

---

## 7. 收消息与渲染

```
RemoteComClient 收到 message(from, message)
  → ReplyTracker.recordIncomingMessage
  → 如果当前 agent 忙:
      - queueIdleMessage
  → 如果当前 agent idle:
      - sendIncomingMessage 注入 Pi 对话
  → UI 使用 InlineMessageComponent 渲染
```

渲染规则：

- from 展示为 `name@nodeName`。
- 同时展示 cwd/runtime/status 作为辅助信息。
- 如果 `expectsReply` 为 true，提示：`com({ action: "reply", message: "..." })`。

---

## 8. 面板结构

```
macbook-pro
  ~/projects/agentcom
    • main@macbook-pro (pi) [self, idle]
    • backend@macbook-pro (pi) [same cwd, thinking]
  ~/other
    • qa@macbook-pro (pi) [tool:bash]

devbox-jp
  /home/dev/app
    • architect@devbox-jp (codex) [thinking]
```

面板规则：

- 第一层按 nodeName 分组。
- 第二层按 cwd 分组。
- 第三层展示 runtime、status、self/same cwd 标签。
- 用户选择 session 后进入 compose overlay。
- 面板发送仍然走 `client.send(session.id, ...)`，不把 `session@node` 发到底层协议。
