# agentcom

Remote 1:1 messaging between Pi sessions across machines.

agentcom gives every Pi session an address like `planner@imac` or `worker@macbook`, then lets users or agents list online sessions, send messages, ask for replies, and answer pending asks through `/com` or the `com` tool.

> [!NOTE]
> This README focuses on getting agentcom running. For Worker internals, tests, and deployment operations, see [`server/agentcom/README.md`](server/agentcom/README.md).

## What you can do

- **Message another machine** — send from `alice@imac` to `bob@macbook` over WebSocket.
- **Coordinate agents** — let one Pi session delegate, ask, or report back to another session.
- **Use human-gated device auth** — protect browser auth pages with Cloudflare Access, then connect Pi with short-lived device tokens.
- **Keep addresses readable** — target by session id, session name, or full `session-name@node-name` address.

## Prerequisites

- Node.js with modern Web APIs (`fetch`, `WebSocket`, `crypto.subtle`).
- A Cloudflare account with Workers, Durable Objects, and Zero Trust Access.
- Wrangler login:

  ```bash
  npm install
  npx wrangler whoami
  ```

- Pi installed on every machine that should join agentcom.

## 1. Configure and deploy the Worker

Create a production Worker config from the checked-in test config:

```bash
cp server/agentcom/wrangler.test.toml server/agentcom/wrangler.toml
```

Edit `server/agentcom/wrangler.toml`:

```toml
name = "agentcom"
main = "src/index.ts"
compatibility_date = "2026-06-05"
workers_dev = true

[observability.logs]
enabled = true
invocation_logs = true

[vars]
TEAM_DOMAIN = "https://<your-team>.cloudflareaccess.com"
POLICY_AUD = "<Cloudflare Access Application Audience AUD Tag>"

[[durable_objects.bindings]]
name = "ROOM"
class_name = "ComRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ComRoom"]
```

Then set the token signing secret with Wrangler, not in Git:

```bash
openssl rand -base64 32
npx wrangler secret put DEVICE_TOKEN_HMAC_SECRET --config server/agentcom/wrangler.toml
```

Deploy:

```bash
npm test
npm run typecheck
npx wrangler deploy --config server/agentcom/wrangler.toml
```

Your Worker base URL will look like:

```text
https://agentcom.<account>.workers.dev
```

## 2. Configure Cloudflare Access

Create a Cloudflare Zero Trust Access application for the browser auth pages only:

```text
Zero Trust → Access → Applications → Add application → Self-hosted
```

Use this hostname/path:

```text
Domain: agentcom.<account>.workers.dev
Path: /auth/*
```

Add a policy that allows the people who may register devices, for example:

```text
Allow → Include → Emails → you@example.com
```

Copy the application **Audience (AUD) Tag** into `POLICY_AUD` in `server/agentcom/wrangler.toml`, then redeploy if you changed it.

> [!IMPORTANT]
> Protect `/auth/*` only. Do **not** put `/ws` behind Cloudflare Access. Pi sessions connect to `/ws` directly and agentcom authenticates them with device tokens and device signatures.

Quick checks:

```bash
curl -i https://agentcom.<account>.workers.dev/
curl -i https://agentcom.<account>.workers.dev/ws
```

Expected `/ws` result for a plain HTTP request:

```text
HTTP/2 426
Expected Upgrade: websocket
```

## 3. Install the Pi extension

Install agentcom as a Pi package on every machine that should participate:

```bash
# From Git, once the repository is available to your Pi environment
pi install git:github.com/ninehills/agentcom

# Or for local development
pi install /absolute/path/to/agentcom
```

Restart Pi after installing. The extension registers:

- `/com` command for users.
- `com` tool for agents.

agentcom stores local config and device credentials under:

```text
~/.config/agentcom/config.json
~/.config/agentcom/credentials.json
```

Common optional settings:

```json
{
  "autoJoin": true,
  "confirmSend": false,
  "replyHint": true
}
```

## 4. Join a Worker from Pi

In a Pi session, start auth:

```text
/com auth
```

When prompted, enter the Worker base URL:

```text
https://agentcom.<account>.workers.dev
```

Open the shown `/auth/device` URL in your browser, sign in through Cloudflare Access, then copy the generated join command:

```text
/com join wss://agentcom.<account>.workers.dev/ws com_dev_...
```

Run it inside Pi. The session should report a joined node and session id.

Check status:

```text
/com status
```

Rename the current node if you want a stable, friendly address:

```text
/com rename imac
```

> [!TIP]
> Device tokens are short-lived and one-time use. After the first join, agentcom saves a device key locally and reconnects automatically on future Pi starts.

## 5. Send messages

Open Pi on two machines, join both to the same Worker, and optionally name the sessions:

```text
/name planner
/com rename imac
```

List online sessions:

```text
/com list
```

Example output:

```text
planner@imac id=s-0bkl2sm4 node=imac cwd=/repo runtime=pi status=idle model=openai/gpt-5
worker@macbook id=s-x8p2nq9a node=macbook cwd=/repo runtime=pi status=working model=openai/gpt-5
```

Send a fire-and-forget message:

```text
/com send worker@macbook Please check the failing auth test.
```

Ask and wait for a reply:

```text
/com ask planner@imac Should retry apply to POST requests too?
```

Reply to the latest pending ask:

```text
/com reply No, only idempotent requests.
```

If a short name is ambiguous, use the full address or session id:

```text
/com send s-x8p2nq9a Hello from the other machine.
```

## 6. Let agents use `com`

Agents can use the same channel through the registered tool:

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

Use `send` for notifications and `ask` only when the sender needs the reply before continuing.

## 7. Manage devices

Open the device page from Pi:

```text
/com device
```

Or visit directly:

```text
https://agentcom.<account>.workers.dev/auth/devices
```

From there you can see registered devices, online sessions, and revoke devices that should no longer connect.

To remove the current local credential from Pi:

```text
/com leave
```

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `/com status` says not configured | Run `/com auth`, then `/com join ...`. |
| `/auth/device` returns `Unauthorized` | Check Cloudflare Access policy and `TEAM_DOMAIN` / `POLICY_AUD`. |
| `/auth/device` says Worker misconfigured | Set `DEVICE_TOKEN_HMAC_SECRET` with `wrangler secret put`. |
| `/ws` redirects to Access | Access is protecting too much. Restrict it to `/auth/*`. |
| Target name matches multiple sessions | Use `session@node` or the `s-...` session id from `/com list`. |
| A device should stop connecting | Open `/com device` and revoke it. |

More operational details are in [`server/agentcom/README.md`](server/agentcom/README.md).
