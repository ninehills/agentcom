# Issue #3/#4 交接：Pi `/com` 插件通信闭环与高级交互

## 当前状态

已完成 GitHub Issues #3 和 #4 的主要实现、真实验证、集成测试拆分，以及后续按 pi-intercom 风格做的 Pi package 结构重构。当前变更已 staged，但尚未 commit / push。

相关 issue：
- #3：实现 Pi 插件 `/com` 命令基础通信闭环
- #4：实现 Pi ask/reply、com tool、消息渲染和面板

## 最新架构重点

Pi 扩展不再使用 `.pi/extensions/agentcom.ts`，也不再让 smoke test 指向源码文件。现在参考 pi-intercom 的 package 设计：

- `packages/pi-agentcom/package.json`
  - `keywords: ["pi-package"]`
  - `pi.extensions: ["./src/index.ts"]`
- `packages/pi-agentcom/src/index.ts`
  - Pi extension 入口
  - 注册 `/com` command
  - 注册 `com` tool
  - 注册 `agentcom_message` message renderer
  - 绑定 `session_start` / `turn_start` / `turn_end` / `session_shutdown`
- `scripts/agentcom-pi-extension-smoke.mjs`
  - 使用 `pi -e packages/pi-agentcom`
  - 验证 package-level extension 能注册 `/com`

明确不要恢复这些错误方向：

- 不要提交 `.pi/extensions/agentcom.ts`；`.pi/` 被 ignore，不应作为源码。
- 不要用 `pi -e packages/pi-agentcom/src/index.ts` 作为最终 smoke 路径。
- 不要照搬 pi-intercom 的 broker；agentcom 传输是 Worker WebSocket，broker 只作为结构参考，不是需求。

## 关键改动位置

不要从本文复述完整 diff，直接查看这些路径：

- Pi package：`packages/pi-agentcom/`
  - `src/index.ts`：extension 入口
  - `src/runtime.ts`：连接生命周期、命令/tool 编排、RemoteComClient 调用
  - `src/reply-tracker.ts`：incoming message / pending ask / turn context 追踪
  - `src/ui/session-list.ts`：按 node/cwd/runtime 排序和 panel label
  - `src/ui/compose.ts`：消息草稿输入 helper
  - `src/ui/inline-message.ts`：inline message details / renderer fallback
  - `test/runtime.test.ts`：命令、tool、ask/reply、panel、message entry 测试
- Pi extension smoke：`scripts/agentcom-pi-extension-smoke.mjs`
- 真实集成测试入口：`scripts/agentcom-real-integration.mjs`
- 真实集成测试拆分模块：`scripts/agentcom-real-integration/`
- workspace / scripts / TS references：`package.json`、`package-lock.json`、`tsconfig.json`
- 本交接文档：`docs/handoff/issue-3-4.md`

## 已完成的能力

基础 `/com`：

- `/com auth`、`device`、`join`、`list`、`send`、`status`、`rename`、`leave`
- session start 时只读取当前 `config.serverUrl` 对应 credential 自动连接
- `/com leave` 只删除当前 server credential，保留其他 server credential
- 用户可读错误路径：未连接、目标不唯一、token 过期、设备撤销、缺少 authUrl 等

高级交互：

- `/com ask`、`reply`、`pending`
- `com` tool：`list/send/ask/reply/pending/status`
- incoming message 通过 `ReplyTracker.recordIncomingMessage()` 记录
- `expectsReply` 消息生成 `com({ action: "reply", msg: "...", replyTo: "..." })` 提示
- 非 idle 时会 queue turn context，并走 follow-up 提示路径
- 无参数 `/com` panel flow 使用 node / cwd / session label，选择后 compose 并发送

近期修复/重构：

- 删除了错误的 `.pi/extensions/agentcom.ts` 源码路径。
- 删除了临时 `src/extension.ts`，改为 `src/index.ts` package extension 入口。
- 拆出 `ReplyTracker`，避免 ask/reply 状态塞在 `runtime.ts`。
- 拆出 `ui/*` helper，避免 panel/inline/compose 全部塞在 runtime。
- 修复 `/com ask` send 失败/抛错时 timeout 未清理的问题。
- 修复 Node strip-only TS 对 parameter property 不支持导致真实集成失败的问题。
- 集成测试 harness 复用 `@agentcom/client/crypto`。
- runtime 单测移除全局 fake UI 状态，并用 `mkdtemp`。

## 集成测试拆分现状

`src/agentcom-real-integration.mjs` 已拆成薄入口，主要逻辑在：

- `scripts/agentcom-real-integration/harness.mjs`：日志、HTTP/WebSocket、token、client/runtime 工厂、通用 helper
- `scripts/agentcom-real-integration/scenarios/protocol.mjs`：Worker 协议基础场景
- `scripts/agentcom-real-integration/scenarios/remote-client.mjs`：`RemoteComClient` 真实场景
- `scripts/agentcom-real-integration/scenarios/pi-runtime.mjs`：Pi `/com` runtime join/list/send/ask/reply/panel 场景
- `scripts/agentcom-real-integration/scenarios/devices.mjs`：设备页、撤销和清理

真实集成测试默认打到：`https://agentcom-test.swulling.workers.dev`。

## 最近验证命令

最近一次全部通过：

```bash
npm test
npm run typecheck
npm run test:pi-extension
npm run test:integration:real
```

`test:pi-extension` 当前期望输出类似：

```text
PASS pi -e extension smoke: /com registered from .../packages/pi-agentcom/src/index.ts
```

`test:integration:real` 已覆盖 Worker + `RemoteComClient` + `AgentComRuntime`，包含 join/list/send/ask/reply/panel-send 和设备清理。

## 当前工作树

最近看到的 `git status --short --branch -uall`：

```text
## main...origin/main
A  docs/handoff/issue-3-4.md
M  package-lock.json
M  package.json
A  packages/pi-agentcom/package.json
A  packages/pi-agentcom/src/index.ts
A  packages/pi-agentcom/src/reply-tracker.ts
A  packages/pi-agentcom/src/runtime.ts
A  packages/pi-agentcom/src/ui/compose.ts
A  packages/pi-agentcom/src/ui/inline-message.ts
A  packages/pi-agentcom/src/ui/session-list.ts
A  packages/pi-agentcom/test/runtime.test.ts
A  packages/pi-agentcom/tsconfig.json
A  scripts/agentcom-pi-extension-smoke.mjs
M  scripts/agentcom-real-integration.mjs
A  scripts/agentcom-real-integration/harness.mjs
A  scripts/agentcom-real-integration/scenarios/devices.mjs
A  scripts/agentcom-real-integration/scenarios/pi-runtime.mjs
A  scripts/agentcom-real-integration/scenarios/protocol.mjs
A  scripts/agentcom-real-integration/scenarios/remote-client.mjs
M  tsconfig.json
```

之前出现过 `skills-lock.json` 未跟踪文件；最新 status 中没有看到它。下一会话仍建议再跑一次 `git status --short --branch -uall` 确认。

## 下一会话建议

1. 先确认 staged diff：
   - `git diff --cached --stat`
   - 重点看 `packages/pi-agentcom/src/index.ts`、`runtime.ts`、`reply-tracker.ts`、`ui/*`
2. 再跑必要验证：
   - `npm test`
   - `npm run typecheck`
   - `npm run test:pi-extension`
   - 如网络/Worker 可用，再跑 `npm run test:integration:real`
3. 如果继续 commit/push：
   - 重新记录 `git rev-parse HEAD`
   - 确认 `main...origin/main` 没有并发变化
   - commit 前后都重新看 `git status --short --branch -uall`
4. 如需要更新 issue 状态，引用上述测试证据更新 GitHub Issues #3/#4。

建议技能：

- `check`：最终 diff/提交前审查、安全门和 push。
- `review-code`：只审当前 staged diff。
- `triage`：更新 GitHub issue 状态或补充验收证据。
