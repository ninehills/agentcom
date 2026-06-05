# agentcom 协议设计

## 版本

- **版本**: 1.0
- **日期**: 2026-06-05
- **父文档**: [总体设计](agentcom.md)

---

## 1. 设计边界

本文定义跨包共享的接口、消息形状和解析规则。可以保留接口定义，但不放具体实现代码。

关键边界：

- 底层 WebSocket 协议只按 **session id** 投递消息。
- 用户输入的 `session-name@node-name` 只存在于命令/tool/UI 层。
- 客户端发送前先通过 `list` 获取在线会话，再用 `resolveTarget()` 把用户输入解析为唯一 `sessionId`。
- 服务端收到 `send` 后只查找 `send.to` 对应的在线 session，不解析名称。

---

## 2. 核心类型 (`packages/protocol/src/types.ts`)

```ts
export interface NodeInfo {
  nodeId: string;
  nodeName: string;
  hostname: string;
  deviceId: string;
  publicKeyJwk: JsonWebKey;
  email: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt?: number;
}

export interface SessionInfo {
  id: string;           // 服务端生成: "s-" + 8 位短 id
  name: string;         // 运行时别名；客户端未提供时由服务端设为 id
  nodeId: string;
  nodeName: string;
  address: string;      // "${name}@${nodeName}"
  cwd: string;
  model: string;
  runtime: string;      // "pi" | "codex" | "claude" | ...
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
}

export interface Message {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}
```

### Session name 默认值

客户端注册时 `session.name` 可以为空。服务端生成 `sessionId` 后统一计算：

```
requestedName 非空 → name = requestedName
requestedName 为空 → name = sessionId
address = name + "@" + nodeName
```

---

## 3. WebSocket 消息接口 (`packages/protocol/src/messages.ts`)

### 3.1 认证期

```ts
export interface SessionRegistration {
  name?: string;
  cwd: string;
  model: string;
  runtime: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
}

export type AuthMessage =
  | {
      type: "register_device";
      requestId: string;
      deviceToken: string;
      hostname: string;
      preferredNodeName?: string;
      publicKeyJwk: JsonWebKey;
      session: SessionRegistration;
    }
  | { type: "auth_begin"; requestId: string; deviceId: string }
  | {
      type: "auth_finish";
      requestId: string;
      deviceId: string;
      signature: string;
      session: SessionRegistration;
    };

export type AuthResponse =
  | {
      type: "register_ok";
      requestId: string;
      sessionId: string;
      deviceId: string;
      nodeId: string;
      nodeName: string;
    }
  | { type: "register_failed"; requestId: string; reason: string }
  | { type: "auth_challenge"; requestId: string; nonce: string }
  | { type: "auth_failed"; requestId: string; reason: string };
```

认证调用链：

```
首次注册:
  Client → register_device(deviceToken, publicKeyJwk, session)
  Server → 校验 token → 创建 device/node/session → register_ok

后续重连:
  Client → auth_begin(deviceId)
  Server → auth_challenge(nonce)
  Client → auth_finish(signature, session)
  Server → 验签 → 创建在线 session → register_ok
```

### 3.2 会话期

```ts
export type ClientMessage =
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; message: Message }
  | { type: "presence"; name?: string; status?: string; model?: string }
  | { type: "rename_node"; requestId: string; nodeName: string }
  | { type: "unregister" };

export type ServerMessage =
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; from: SessionInfo; message: Message }
  | { type: "delivered"; messageId: string }
  | { type: "delivery_failed"; messageId: string; reason: string }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "node_renamed"; requestId: string; nodeId: string; nodeName: string }
  | { type: "error"; error: string };
```

会话期调用链：

```
list:
  Client → list(requestId)
  Server → sessions(requestId, sessions)

send 成功:
  命令/tool 层 → resolveTarget(sessions, "main@macbook-pro") → "s-1a2b3c4d"
  Client → send(to: "s-1a2b3c4d", message)
  Server → sessions.get(to) → 目标收到 message(from, message)
  Server → 发送方收到 delivered(messageId)

send 失败:
  Client → send(to: "s-missing", message)
  Server → delivery_failed(messageId, reason)

presence:
  Client → presence(name/status/model)
  Server → 更新在线 SessionInfo
  约束: name 变化不广播，只影响后续 list/resolve

rename_node:
  Client → rename_node(requestId, nodeName)
  Server → 更新该节点下所有在线 session 的 nodeName/address
  Server → node_renamed(requestId, nodeId, nodeName)
  约束: 不广播 rename，只影响后续 list/resolve
```

---

## 4. 地址解析接口 (`packages/protocol/src/address.ts`)

```ts
export interface ParsedAddress {
  sessionName?: string;
  nodeName?: string;
  isId: boolean;
}

export interface ResolveResult {
  found: boolean;
  sessionId?: string;
  reason?: string;
}

export function parseAddress(input: string): ParsedAddress;
export function resolveTarget(sessions: SessionInfo[], input: string): ResolveResult;
```

解析规则：

| 输入 | 解释 | 匹配规则 |
|------|------|----------|
| `s-xxxxxxxx` 或 UUID | session id | 精确匹配 `SessionInfo.id` |
| `name@node` | 完整地址 | 按 `name + nodeName` 精确匹配；多个匹配时报错 |
| `name` | session-name | 全 room 唯一时自动匹配；多个匹配时报错 |

报错文案必须能直接展示给用户，尤其是多重匹配时要提示使用 session id。

---

## 5. 客户端发送接口

```ts
export interface SendOptions {
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  expectsReply?: boolean;
  messageId?: string;
}

export interface SendResult {
  id: string;
  delivered: boolean;
  reason?: string;
}
```

语义约束：

- `RemoteComClient.send(toSessionId, options)` 的 `toSessionId` 必须已经是 session id。
- `send` 等待 `delivered` / `delivery_failed`，默认 10 秒超时。
- `ask` 在 `send(expectsReply: true)` 成功后等待 reply，默认 10 分钟超时。
- `reply` 通过 ReplyTracker 找到 pending ask，并发送 `replyTo: originalMessage.id`。
