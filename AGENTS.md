## Agent 技能

### Issue tracker

Issue 使用 GitHub Issues，仓库为 `ninehills/agentcom`。见 `docs/agents/issue-tracker.md`。

### Triage labels

标准五标签词汇：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 `docs/agents/triage-labels.md`。

### 领域文档

仓库根目录只保留一个 `CONTEXT.md` 加 `docs/adr/`。见 `docs/agents/domain.md`。

## 项目文档索引

- `CONTEXT.md`：领域语言，包含房间、设备、节点、会话等术语。
- `docs/prd/agentcom.md`：产品需求与验收标准。
- `docs/design/agentcom.md`：总体设计与包结构索引。
- `docs/design/protocol.md`：Worker 协议、消息类型、`parseAddress` / `resolveTarget` 行为。
- `docs/design/worker.md`：Cloudflare Worker / Durable Object 设计。
- `docs/design/pi-agentcom.md`：Pi 插件与 `RemoteComClient` 调用链设计。
- `server/agentcom/README.md`：Worker 开发、测试、部署和真实集成测试手册。
- `docs/handoff/`：跨会话交接文档；继续未完成切片前先查看相关 issue 的 handoff。
