# agentcom Worker 设计

## 版本

- **版本**: 1.0
- **日期**: 2026-06-05
- **父文档**: [总体设计](agentcom.md)

---

## 1. 设计边界

本文只描述 Cloudflare Worker + Durable Object 的职责、接口、状态和调用链路，不保留具体实现代码。

Worker 端必须遵守两条边界：

1. `/auth/*` 是人类浏览器入口，受 Cloudflare Access 保护。
2. `/ws` 是 agent 客户端入口，公开暴露，但必须通过设备注册或设备签名完成鉴权。

消息投递边界：

- 服务端协议层只接受 `sessionId`。
- 服务端不解析 `session-name@node-name`。
- `session-name@node-name` 的解析只发生在客户端命令/tool 层。

---

## 2. 路由总览

```
agentcom.<subdomain>.workers.dev
  ├── GET  /ws             → WebSocket upgrade → ComRoom DO
  │                            公开入口；设备 token / 设备签名鉴权
  ├── GET  /auth/device    → Cloudflare Access → ComRoom DO
  │                            生成一次性 device token
  ├── GET  /auth/devices   → Cloudflare Access → ComRoom DO
  │                            展示当前登录邮箱注册的设备
  ├── POST /auth/revoke    → Cloudflare Access → ComRoom DO
  │                            撤销当前登录邮箱名下的设备
  ├── POST /auth/delete    → Cloudflare Access → ComRoom DO
  │                            删除当前登录邮箱名下已撤销的设备
  └── GET  /               → 健康检查
```

路由规则：

| 路径 | 是否受 Access 保护 | 调用方 | 作用 |
|------|--------------------|--------|------|
| `/ws` | 否 | agent 客户端 | WebSocket 连接与消息通信 |
| `/auth/device` | 是 | 浏览器 | 生成 device token 与 join 命令 |
| `/auth/devices` | 是 | 浏览器 | 查看自己邮箱注册的设备 |
| `/auth/revoke` | 是 | 浏览器表单 | 撤销自己邮箱注册的设备 |
| `/auth/delete` | 是 | 浏览器表单 | 删除自己邮箱注册且已撤销的设备 |
| `/` | 否 | 任意 | 健康检查 |

---

## 3. Worker 入口调用链

```
HTTP request
  → parse pathname
  → if pathname == /ws:
      - 要求 WebSocket upgrade
      - 转发到固定 ComRoom DO: idFromName("default")
  → else if pathname startsWith /auth/:
      - 校验 Cloudflare Access JWT
      - 从 JWT 提取 email
      - 转发到固定 ComRoom DO，并附加已验证 email
  → else:
      - 返回健康检查文本
```

Access JWT 校验职责：

- 必须校验 `cf-access-jwt-assertion`。
- 必须校验 issuer 与 audience。
- 必须提取 email。
- DO 只信任 Worker 转发的已验证 email，不自行信任浏览器传入的任意 email 字段。

---

## 4. ComRoom Durable Object 状态

### 4.1 持久化状态

| Key | Value | 用途 |
|-----|-------|------|
| `device:<deviceId>` | device record | 已注册设备；包含 `nodeId`、`publicKeyJwk`、`email`、`createdAt`、可选 `revokedAt` |
| `node:<nodeId>` | node record | 节点展示身份；包含 `nodeName`、`hostname`、`deviceId`、`email`、`createdAt` |
| `token:<tokenHash>` | token record | 一次性注册 token；包含 `email`、`expiresAt`、`createdAt`、可选 `usedAt` |

持久化约束：

- device token 只存 HMAC hash，不存明文。
- private key 永远不进入服务端。
- public key 只用于后续挑战-应答验签。
- 设备与节点一一对应。
- 设备被撤销后，持久化记录保留并写入 `revokedAt`。

### 4.2 内存状态

| 状态 | Key | Value | 生命周期 |
|------|-----|-------|----------|
| `sessions` | `sessionId` | WebSocket、SessionInfo、nodeId、deviceId | WebSocket 在线期间 |
| `pendingAuth` | nonce 或连接标识 | nonce、deviceId、WebSocket | auth_begin 到 auth_finish 之间 |

内存状态约束：

- session id 表示一次在线连接，断开重连可以变化。
- session id 格式为短格式：`s-xxxxxxxx`。
- 未命名 session 的默认 name 由服务端在生成 session id 后设置为该 session id。
- 同名 session 不自动加后缀；发送时若解析到多个 session，由客户端命令/tool 层报错并提示使用 session id。

---

## 5. WebSocket 生命周期

```
/ws upgrade
  → ComRoom 接受 WebSocket
  → connection state = auth_required

收到认证期消息:
  → register_device 走首次注册
  → auth_begin/auth_finish 走后续重连

认证成功:
  → 生成 sessionId
  → 计算 effective session name:
      requestedName 不为空 → requestedName
      requestedName 为空   → sessionId
  → 创建 SessionInfo
  → 写入 sessions
  → 返回 register_ok
  → 广播 session_joined

收到会话期消息:
  → list / send / presence / rename_node / unregister

WebSocket close:
  → 如果已有在线 session:
      - 从 sessions 删除
      - 广播 session_left(sessionId)
```

---

## 6. 首次注册流程

场景：用户通过浏览器访问 `/auth/device` 获取 token，然后在目标机器执行 `/com join <ws_url> <device_token>`。

```
/auth/device
  → Access 验证用户
  → Worker 提取 email
  → DO 生成 com_dev_xxxxx
  → DO 保存 tokenHash + email + expiresAt
  → 页面展示 token 与完整 /com join 命令

/com join
  → 客户端生成 P-256 keypair
  → 客户端连接 /ws
  → 客户端发送 register_device(deviceToken, publicKeyJwk, hostname, preferredNodeName, session)

DO.handleRegisterDevice
  → 校验 tokenHash 存在、未过期、未使用
  → 根据 preferredNodeName/hostname 分配 nodeName
  → 创建 deviceId 与 nodeId
  → 持久化 device record 与 node record
  → 标记 token usedAt
  → 生成 sessionId
  → 如果 session.name 为空，则 name = sessionId
  → 创建在线 SessionInfo
  → 返回 register_ok(sessionId, deviceId, nodeId, nodeName)
  → 广播 session_joined
```

失败规则：

| 条件 | 返回 |
|------|------|
| token 不存在 | `register_failed: Invalid or expired device token` |
| token 已过期 | `register_failed: Invalid or expired device token` |
| token 已使用 | `register_failed: Invalid or expired device token` |
| publicKey 格式无效 | `register_failed: Invalid public key` |

---

## 7. 后续重连流程

场景：pi 重启后读取当前 `config.serverUrl` 对应的 credential，自动连接 `/ws`。

```
客户端启动
  → 读取 config.serverUrl
  → 读取 credentials[serverUrl]
  → 如果 credential 存在，连接 /ws

挑战-应答
  → Client: auth_begin(deviceId)
  → DO: 查 device 存在且未 revoked
  → DO: 生成 nonce 并记录 pendingAuth
  → Server: auth_challenge(nonce)
  → Client: 用本地 privateKey 签名 nonce
  → Client: auth_finish(deviceId, signature, session)
  → DO: 验证 pendingAuth 与 deviceId
  → DO: 使用 device.publicKeyJwk 验签
  → DO: 读取 nodeName
  → DO: 生成新的 sessionId
  → DO: 如果 session.name 为空，则 name = sessionId
  → DO: 创建在线 SessionInfo
  → Server: register_ok(sessionId, deviceId, nodeId, nodeName)
  → Server: 广播 session_joined
```

失败规则：

| 条件 | 返回 |
|------|------|
| device 不存在 | `auth_failed: Device not found or revoked` |
| device 已撤销 | `auth_failed: Device not found or revoked` |
| 没有 pendingAuth | `auth_failed: No pending auth` |
| 签名无效 | `auth_failed: Invalid signature` |

客户端收到 `auth_failed` 后只提示重新认证/加入，不自动删除本地 credential；`/com leave` 负责清理本地 credential。

---

## 8. 会话操作

### 8.1 list

```
Client → list(requestId)
DO → 返回当前 sessions 中的 SessionInfo[]
```

约束：

- `sessions` 只包含在线 session。
- 返回结果用于客户端 UI 展示和目标解析。
- 服务端不负责按 `session-name@node-name` 解析目标。

### 8.2 send

```
客户端命令/tool 层
  → list()
  → resolveTarget(sessions, 用户输入)
  → 得到唯一 sessionId
  → send(to: sessionId, message)

DO.handleSend
  → 查找发送方 WebSocket 对应的 SessionInfo
  → 校验 to 是 session id
  → 校验 message 形状
  → 禁止发送给自己
  → sessions.get(to)
  → 若目标存在，向目标发送 message(from, message)
  → 向发送方返回 delivered(messageId)
```

失败规则：

| 条件 | 返回 |
|------|------|
| 发送方未认证 | `delivery_failed: Sender not found` |
| `to` 不是 session id | `delivery_failed: Invalid send message` |
| message 形状无效 | `delivery_failed: Invalid send message` |
| 发送给自己 | `delivery_failed: Cannot message self` |
| 目标 session 不在线 | `delivery_failed: Session not found` |

### 8.3 presence

```
Client → presence(name/status/model)
DO → 更新当前 session 的内存 SessionInfo
```

约束：

- `name` 变化不广播；只影响后续 `list` 和客户端解析目标。
- `status` / `model` 可以广播 `presence_update`，但第一版正确性不依赖实时广播。
- 如果 name 被清空，服务端应回退为当前 session id，保证 session 始终可寻址。

### 8.4 rename_node

```
Client → rename_node(requestId, nodeName)
DO → 找到当前连接所属 node
DO → 分配无冲突 nodeName
DO → 更新 node record
DO → 更新该 node 下所有在线 session 的 nodeName/address
DO → 返回 node_renamed(requestId, nodeId, nodeName)
```

约束：

- 节点重命名不广播。
- 改名只影响后续 `list`、目标解析和 UI 展示。
- 同名冲突时服务端可自动分配后缀。

### 8.5 unregister / close

```
Client → unregister 或 WebSocket close
DO → 删除对应 session
DO → 广播 session_left(sessionId)
```

---

## 9. HTTP 内部操作

### 9.1 `/auth/device`

```
Access-authenticated browser request
  → Worker 提取 email
  → DO 创建 5 分钟一次性 token
  → DO 保存 tokenHash
  → HTML 页面展示:
      - 当前登录 email
      - device token
      - /com join <wss_url> <device_token>
```

规则：

- 每次访问都生成新的 5 分钟一次性 token。
- 同一邮箱可以同时存在多个未使用 token。
- 页面根据当前请求域名推导 `wss://<host>/ws`。

### 9.2 `/auth/devices`

```
Access-authenticated browser request
  → Worker 提取 email
  → DO 列出 device records
  → 只展示 device.email == 当前 email 的设备
  → active 行正常显示
  → revoked 行灰色显示
  → active 行提供 Revoke 表单按钮
  → revoked 行提供 Delete permanently 表单按钮
  → 每个 device 行内展示该 device 当前在线 sessions 的完整 SessionInfo 字段
```

规则：

- 用户只能查看自己邮箱注册的设备。
- 不做 room 管理员任意撤销。
- 撤销和删除前使用浏览器原生 confirm。
- session 展示仅来自当前 DO 内存/hibernation attachment 中在线连接；离线 session 不保留。

### 9.3 `/auth/revoke`

```
Access-authenticated POST
  → Worker 提取 email
  → DO 读取 deviceId
  → 校验 device.email == 当前 email
  → 写入 revokedAt
  → 断开该设备的所有在线 session
  → 303 redirect 到 /auth/devices
```

规则：

- 用户只能撤销自己邮箱注册的设备。
- 撤销后服务端拒绝该设备后续重连。
- 客户端本地 credential 不自动删除。

### 9.4 `/auth/delete`

```
Access-authenticated POST
  → Worker 提取 email
  → DO 读取 deviceId
  → 校验 device.email == 当前 email
  → 校验 device.revokedAt 已存在
  → 删除 device:<deviceId> 与 node:<nodeId>
  → 303 redirect 到 /auth/devices
```

规则：

- 用户只能删除自己邮箱注册且已经撤销的设备。
- 未撤销设备返回 409，必须先 revoke 再 delete。
- 删除后 nodeName 可被后续注册重新分配。

---

## 10. 辅助规则

### 10.1 nodeName 分配

```
normalize(preferred):
  → 只保留字母、数字、短横线
  → 转小写
  → 空值回退为 "node"

allocate:
  → 如果 base 未占用，使用 base
  → 如果 base 已占用，追加随机 4 位后缀
  → 如果多次冲突，追加更长随机后缀
```

### 10.2 token 存储

```
token 明文只展示给浏览器页面一次
DO 存储 HMAC(token)
注册时用 HMAC(inputToken) 查找 token record
```

### 10.3 message 校验

```
Message 必须包含:
  - id
  - timestamp
  - content.text

可选:
  - replyTo
  - expectsReply
  - content.attachments
```

---

## 11. 部署配置

### 11.1 `server/agentcom/wrangler.toml` 需要表达的配置

```toml
name = "agentcom"
main = "src/index.ts"
compatibility_date = "2026-06-05"
workers_dev = true

[[durable_objects.bindings]]
name = "ROOM"
class_name = "ComRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ComRoom"]

[vars]
TEAM_DOMAIN = "https://<your-team>.cloudflareaccess.com"
POLICY_AUD = "<access-application-aud-tag>"
```

### 11.2 部署流程

```
cd server/agentcom
pnpm install
设置 DEVICE_TOKEN_HMAC_SECRET
pnpm wrangler deploy
```

### 11.3 Cloudflare Access 配置

```
Zero Trust → Access → Applications → Add app
  Type: Self-hosted
  Application name: agentcom
  Domain: agentcom.<subdomain>.workers.dev
  Path: /auth/*
  Identity Provider: Cloudflare
  Policy: Allow → Include → Cloudflare Account Member
  复制 Access Application AUD 到 POLICY_AUD
```

注意：`/ws` 不在 Access Application 中，保持公开入口，由设备签名鉴权保护。
