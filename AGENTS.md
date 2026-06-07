## Agent 技能

### Issue tracker

Issue 使用 GitHub Issues，仓库为 `ninehills/agentcom`。见 `docs/agents/issue-tracker.md`。

### Triage labels

标准五标签词汇：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 `docs/agents/triage-labels.md`。

### 领域文档

仓库根目录只保留一个 `CONTEXT.md` 加 `docs/adr/`。见 `docs/agents/domain.md`。

## 验证要求

任何功能修改或 bugfix 完成前，必须跑完整验证，不允许只跑单元测试就声称完成：

1. `npm run typecheck`
2. `npm test`
3. `npm run test:pi-extension`
4. `npx wrangler deploy --config server/agentcom/wrangler.test.toml`
5. `npm run test:integration:real`

`test:integration:real` 是真实 HTTP + WebSocket + Pi Runtime e2e，覆盖 Worker、`RemoteComClient`、`AgentComRuntime` 的 join/list/send/ask/reply/panel-send 和设备管理。凡是通信、Worker、Pi 扩展、tool/command 行为相关改动，都必须以它通过作为最终验收。

如果由于网络、Cloudflare 登录、权限或外部服务问题无法运行完整验证，必须明确说明阻塞原因、已完成的验证命令和未覆盖风险；不能把未跑真实 e2e 的结果说成完成。

## 项目文档索引

- `CONTEXT.md`：领域语言，包含房间、设备、节点、会话等术语。
- `docs/prd/agentcom.md`：产品需求与验收标准。
- `docs/design/agentcom.md`：总体设计与包结构索引。
- `docs/design/protocol.md`：Worker 协议、消息类型、`parseAddress` / `resolveTarget` 行为。
- `docs/design/worker.md`：Cloudflare Worker / Durable Object 设计。
- `docs/design/pi-agentcom.md`：Pi 插件与 `RemoteComClient` 调用链设计。
- `server/agentcom/README.md`：Worker 开发、测试、部署和真实集成测试手册。
- `docs/handoff/`：跨会话交接文档；继续未完成切片前先查看相关 issue 的 handoff。
