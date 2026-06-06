# agentcom

跨机器 Pi session 的远程 1:1 消息通道。

agentcom 会给每个 Pi session 一个类似 `planner@imac` 或 `worker@macbook` 的地址。用户和 agent 都可以通过 `/com` 或 `com` tool 查看在线 session、发送消息、发起需要回复的问题，以及回复待处理问题。

> [!NOTE]
> 本 README 只讲如何开始使用。Worker 内部实现、测试和上线细节见 [`server/agentcom/README.md`](server/agentcom/README.md)。

## 你可以用它做什么

- **跨机器发消息**：从 `alice@imac` 发到 `bob@macbook`。
- **协调多个 agent**：一个 Pi session 做规划，另一个执行或复查。
- **用 Cloudflare Access 做设备注册入口**：浏览器页面受 Access 保护，Pi 通过一次性 device token 加入。
- **用可读地址寻址**：支持 session id、session name、完整 `session-name@node-name` 地址。

## 前置条件

- 一个可用的 Cloudflare 账号，开启 Workers、Durable Objects 和 Zero Trust Access。
  - Zero Trust Acess 应该需要绑定信用卡，但是有免费额度

- Wrangler 已登录：

  ```bash
  npm install
  npx wrangler whoami
  ```

- 每台需要加入 agentcom 的机器都已安装 Pi。

## 1. 配置并部署 Worker

从仓库里的测试配置复制一份生产配置：

```bash
cp server/agentcom/wrangler.test.toml server/agentcom/wrangler.toml
```

编辑 `server/agentcom/wrangler.toml`：

1. 将 `name` 从 `"agentcom-test"` 改为 `"agentcom"`（或你想要的 Worker 名称）。
2. Cloudflare Access 的值先用占位符：

```toml
name = "agentcom"
# ...

[vars]
TEAM_DOMAIN = "https://<your-team>.cloudflareaccess.com"
POLICY_AUD = "<Cloudflare Access Application Audience AUD Tag>"
```

然后用 Wrangler 设置 token 签名密钥

```bash
openssl rand -base64 32
npx wrangler secret put DEVICE_TOKEN_HMAC_SECRET --config server/agentcom/wrangler.toml
```

部署：

```bash
npx wrangler deploy --config server/agentcom/wrangler.toml
```

部署后 Worker 基础 URL 类似：

```text
https://agentcom.<account>.workers.dev
```

![alt text](image.png)

## 2. 配置 Cloudflare Access

在 Worker 中开启 Cloudflare Access 认证，

![alt text](image-1.png)

但是这样会把 `/ws` 也放到 Access 后面，需要修改。

进入 Zero-Trust Dashboard

![alt text](image-2.png)

Path 处加上 `/auth/`，别忘了下方点击 Save：

![alt text](image-3.png)

最后从如下两个地方找到 TEAM 和 AUG Tag：

![alt text](image-4.png)

![alt text](image-5.png)

编辑 `server/agentcom/wrangler.toml`，填入真实信息：

```toml
[vars]
TEAM_DOMAIN = "https://<your-team>.cloudflareaccess.com"
POLICY_AUD = "<Cloudflare Access Application Audience AUD Tag>"
```

然后部署：

```bash
npx wrangler deploy --config server/agentcom/wrangler.toml

# 会打印出来 worker地址，记下来后面用
```

快速验证：

```bash
# 预期200
curl -i https://agentcom.<account>.workers.dev/
# 预期426
curl -i https://agentcom.<account>.workers.dev/ws
# 预期 302
curl -i https://agentcom.<account>.workers.dev/auth/device
```

## 3. 安装 Pi 扩展

在每台需要通信的机器上安装 agentcom Pi package：

```bash
# 仓库可被当前 Pi 环境访问时使用 Git 安装
pi install git:github.com/ninehills/agentcom

# 本地开发时使用本地路径安装
pi install /absolute/path/to/agentcom
```

安装后重启 Pi。扩展会注册：

- `/com` 命令，给用户使用。
  - 直接执行不带参数的 `/com`，可以打开 session 选择和消息编辑面板。
- `com` tool，给 agent 使用。

本地配置和设备凭证会保存到：

```text
~/.config/agentcom/config.json
~/.config/agentcom/credentials.json
```

## 4. 在 Pi 里加入 Worker

在 Pi session 中执行：

```text
/com auth
```

提示输入 Worker 基础 URL 时填：

```text
https://agentcom.<account>.workers.dev
```

打开提示里的 `/auth/device` 页面，通过 Cloudflare Access 登录后，复制页面生成的 join 命令：

```text
/com join wss://agentcom.<account>.workers.dev/ws com_dev_...
```

把它粘回 Pi 里执行。成功后会显示已加入的 node 和 session id。

查看当前状态：

```text
/com status
```

如果希望地址稳定、好记，可以重命名当前节点：

```text
/com rename imac
```

> [!TIP]
> device token 是短期、一次性的。首次 join 成功后，agentcom 会在本地保存设备密钥；以后 Pi 启动时会自动重连。

## 5. 互相发消息

在两台机器上都打开 Pi，加入同一个 Worker，并按需给 session 起名：

```text
/name planner
/com rename imac
```

查看在线 session：

```text
/com list
```

也可以打开交互式面板，选择目标后发送消息：

```text
/com
```

示例输出：

```text
planner@imac id=s-0bkl2sm4 node=imac cwd=/repo runtime=pi status=idle model=openai/gpt-5
worker@macbook id=s-x8p2nq9a node=macbook cwd=/repo runtime=pi status=working model=openai/gpt-5
```

发送一条不等待回复的消息：

```text
/com send worker@macbook Please check the failing auth test.
```

发送一个需要回复的问题：

```text
/com ask planner@imac Should retry apply to POST requests too?
```

回复最近一个待处理问题：

```text
/com reply No, only idempotent requests.
```

如果短名称匹配到多个 session，就用完整地址或 `/com list` 里的 session id：

```text
/com send s-x8p2nq9a Hello from the other machine.
```

## 6. 让 agent 使用 `com`

agent 可以通过注册好的 `com` tool 使用同一条通道：

```typescript
com({ action: "list" })

com({
  action: "send",
  to: "worker@macbook",
  message: "I found the root cause in packages/client/src/com-client.ts."
})

com({
  action: "ask",
  to: "planner@imac",
  message: "Can I change the command wording in README-zh.md as part of this task?"
})

com({ action: "pending" })
com({ action: "reply", message: "Approved." })
com({ action: "status" })
```

建议：普通通知用 `send`；只有发送方必须拿到回复才能继续时，才用 `ask`。

## 7. 管理设备

从 Pi 打开设备管理页：

```text
/com device
```

也可以直接访问：

```text
https://agentcom.<account>.workers.dev/auth/devices
```

这里可以查看已注册设备、在线 session，并 revoke 不应该继续连接的设备。

如果只想删除当前 Pi 本地保存的凭证：

```text
/com leave
```
