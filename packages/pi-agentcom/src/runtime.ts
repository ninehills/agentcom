import { hostname as osHostname } from "node:os";
import { resolveTarget, type AgentComMessage, type Attachment, type SessionInfo, type SessionRegistration } from "@agentcom/protocol";
import { RemoteComClient, type SendResult } from "@agentcom/client/com-client";
import { getConfigPaths, loadConfig, normalizeServerUrl, saveConfig, type AgentComConfig, type ConfigPaths } from "@agentcom/client/config";
import { loadCredential, removeCredential, saveCredential } from "@agentcom/client/credentials";
import type { AgentComCredential } from "@agentcom/client/credentials";
import { ReplyTracker, type AgentComMessageContext } from "./reply-tracker.ts";
import { ComposeOverlay, composeMessage, formatAttachments, type ComposeResult } from "./ui/compose.ts";
import { buildSessionOptions, defaultKeybindings, defaultTheme, SessionListOverlay, sessionDisplayName } from "./ui/session-list.ts";
import { formatInlineMessage, replyCommandFor, type InlineMessageDetails } from "./ui/inline-message.ts";

export interface ClientLike {
  sessionId: string | null;
  nodeId: string | null;
  nodeName: string | null;
  credential: AgentComCredential | null;
  connect(options: unknown): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  updatePresence(updates: { name?: string; status?: string; model?: string }): void;
  listSessions(): Promise<SessionInfo[]>;
  send(toSessionId: string, options: { text: string; attachments?: Attachment[]; replyTo?: string; expectsReply?: boolean; messageId?: string }): Promise<SendResult>;
  renameNode(nodeName: string): Promise<string>;
  onMessage(handler: (from: SessionInfo, message: AgentComMessage) => void): () => void;
}

export interface AgentComUi {
  input?(title: string, placeholder?: string): Promise<string | undefined>;
  select?(title: string, options: string[]): Promise<string | undefined>;
  editor?(title: string, prefill?: string): Promise<string | undefined>;
  confirm?(title: string, message: string): Promise<boolean>;
  custom?<T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown, options?: { overlay?: boolean }): Promise<T>;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
  setStatus?(key: string, text: string | undefined): void;
}

export interface AgentComContext {
  cwd: string;
  model?: string;
  sessionName?: string;
  isIdle?: boolean;
  hasUI?: boolean;
  mode?: string;
  askTimeoutMs?: number;
  ui?: AgentComUi;
  sendMessage?: (message: { customType: string; content: string; display?: boolean; details?: unknown }, options?: { deliverAs?: "steer" | "followUp"; triggerTurn?: boolean }) => void;
  injectMessage?: (message: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
  appendEntry?: (type: string, details: unknown) => void;
}

export interface ComToolParams {
  action: "list" | "send" | "ask" | "reply" | "pending" | "status";
  to?: string;
  message?: string;
  msg?: string;
  attachments?: Attachment[];
  replyTo?: string;
}

interface RuntimeOptions {
  paths?: Partial<ConfigPaths>;
  clientFactory?: (serverUrl: string) => ClientLike;
  now?: () => number;
  randomId?: () => string;
  hostname?: () => string;
}

interface OutgoingAsk {
  to: string;
  targetSessionId: string;
  messageId: string;
  text: string;
  status: "waiting" | "answered" | "timed_out";
  resolve: (message: AgentComMessage) => void;
  cancel: () => void;
}

interface ActionResult {
  ok: boolean;
  text: string;
  details?: Record<string, unknown>;
}

interface PendingIncomingMessage {
  from: SessionInfo;
  message: AgentComMessage;
  context: AgentComMessageContext;
}

export class AgentComRuntime {
  private readonly paths: Partial<ConfigPaths>;
  private readonly clientFactory: (serverUrl: string) => ClientLike;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly getHostname: () => string;
  private config: AgentComConfig & { enabled?: boolean } = {};
  private client: ClientLike | null = null;
  private clientServerUrl: string | null = null;
  private unsubscribeMessage: (() => void) | null = null;
  private latestCtx: AgentComContext | null = null;
  private runtimeGeneration = 0;
  private lastPresenceKey: string | null = null;
  private activityStatus: string | null = null;
  private readonly replyTracker: ReplyTracker;
  private readonly outgoingAsks = new Map<string, OutgoingAsk>();
  private readonly pendingIncomingMessages: PendingIncomingMessage[] = [];

  constructor(options: RuntimeOptions = {}) {
    this.paths = options.paths ?? getConfigPaths();
    this.clientFactory = options.clientFactory ?? ((serverUrl) => new RemoteComClient({ serverUrl }));
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomId;
    this.getHostname = options.hostname ?? osHostname;
    this.replyTracker = new ReplyTracker();
  }

  async start(ctx: AgentComContext): Promise<string> {
    this.latestCtx = ctx;
    this.runtimeGeneration += 1;
    this.config = await loadConfig(this.paths) as AgentComConfig & { enabled?: boolean };
    if (this.config.enabled === false || this.config.autoJoin === false) return "agentcom disabled";
    if (!this.config.serverUrl) return "agentcom not configured";
    const serverUrl = normalizeServerUrl(this.config.serverUrl);
    const credential = await loadCredential(serverUrl, this.paths);
    if (!credential) return `No credential for ${serverUrl}; run /com join for this server.`;

    try {
      const client = this.getClient(serverUrl);
      await client.connect({
        deviceId: credential.deviceId,
        privateKeyJwk: credential.privateKeyJwk,
        publicKeyJwk: credential.publicKeyJwk,
        session: this.registration(ctx),
      });
      this.lastPresenceKey = this.presenceKey(ctx);
      this.attachClient(client);
      return `connected ${client.sessionId ?? "unknown-session"}@${client.nodeName ?? credential.nodeName}`;
    } catch (error) {
      return this.userError(error);
    }
  }

  shutdown(): void {
    this.runtimeGeneration += 1;
    this.cancelOutgoingAsks();
    this.unsubscribeMessage?.();
    this.unsubscribeMessage = null;
    this.client?.disconnect();
    this.client = null;
    this.clientServerUrl = null;
    this.replyTracker.reset();
    this.pendingIncomingMessages.length = 0;
  }

  handleTurnStart(ctx: AgentComContext): void {
    this.latestCtx = ctx;
    this.replyTracker.beginTurn(this.now());
  }

  handleTurnEnd(): void {
    this.replyTracker.endTurn();
    if (this.latestCtx) this.flushPendingIncoming({ ...this.latestCtx, isIdle: true });
  }

  handleAgentStart(ctx: AgentComContext): void {
    this.activityStatus = "thinking";
    this.syncCurrentPresence(ctx);
  }

  handleAgentEnd(ctx: AgentComContext): void {
    this.activityStatus = null;
    this.syncCurrentPresence({ ...ctx, isIdle: true });
  }

  handleToolStart(ctx: AgentComContext, toolName: string): void {
    this.activityStatus = `tool:${toolName || "unknown"}`;
    this.syncCurrentPresence(ctx);
  }

  handleToolEnd(ctx: AgentComContext): void {
    this.activityStatus = "thinking";
    this.syncCurrentPresence(ctx);
  }

  async handleCommand(args: string, ctx: AgentComContext): Promise<string> {
    this.latestCtx = ctx;
    this.config = await loadConfig(this.paths) as AgentComConfig & { enabled?: boolean };
    const [command, rest] = splitCommand(args);
    try {
      switch (command) {
        case "": return await this.panel(ctx);
        case "auth": return await this.auth(ctx);
        case "device": return await this.device(ctx);
        case "join": return await this.join(rest, ctx);
        case "list": return await this.list();
        case "send": return await this.sendCommand(rest, ctx);
        case "ask": return await this.askCommand(rest, ctx);
        case "reply": return await this.reply(rest);
        case "pending": return await this.pending();
        case "status": return await this.status();
        case "rename": return await this.rename(rest);
        case "leave": return await this.leave();
        default: return `Unknown /com command: ${command}`;
      }
    } catch (error) {
      return this.userError(error);
    }
  }

  async handleTool(params: ComToolParams, ctx: AgentComContext, signal?: AbortSignal): Promise<{ ok: boolean; text: string; details?: unknown }> {
    this.latestCtx = ctx;
    this.config = await loadConfig(this.paths) as AgentComConfig & { enabled?: boolean };
    try {
      const message = params.message ?? params.msg ?? "";
      let result: ActionResult;
      switch (params.action) {
        case "list": result = ok(await this.list()); break;
        case "send": result = await this.sendToResult(params.to, message, params.attachments, ctx, params.replyTo); break;
        case "ask": result = await this.askResult(params.to, message, ctx, params.attachments, signal); break;
        case "reply": result = await this.replyResult(message, params.replyTo, params.to); break;
        case "pending": result = ok(await this.pending()); break;
        case "status": result = ok(await this.status()); break;
        default: result = fail(`Unknown com action: ${(params as { action: string }).action}`);
      }
      return { ok: result.ok, text: result.text, details: { action: params.action, ...result.details } };
    } catch (error) {
      return { ok: false, text: this.userError(error) };
    }
  }

  private async auth(ctx: AgentComContext): Promise<string> {
    let authUrl = this.config.authUrl;
    if (!authUrl) {
      authUrl = (await ctx.ui?.input?.("agentcom authUrl", "https://agentcom.example"))?.trim();
      if (!authUrl) return "Missing authUrl. Run /com auth and enter the Worker base URL.";
    }
    const base = normalizeAuthBaseUrl(authUrl);
    await this.saveConfig({ ...this.config, authUrl: base });
    const url = `${base}/auth/device`;
    return this.notify(ctx, `Open ${url}`, "info");
  }

  private async device(ctx: AgentComContext): Promise<string> {
    if (!this.config.authUrl) return this.notify(ctx, "Run /com auth first to configure authUrl.", "warning");
    return this.notify(ctx, `Open ${normalizeAuthBaseUrl(this.config.authUrl)}/auth/devices`, "info");
  }

  private async join(rest: string, ctx: AgentComContext): Promise<string> {
    const [rawServerUrl, deviceToken] = splitN(rest, 2);
    if (!rawServerUrl || !deviceToken) return "Usage: /com join <ws_url> <device_token>";
    const serverUrl = normalizeServerUrl(rawServerUrl);
    this.client?.disconnect();
    this.runtimeGeneration += 1;
    this.cancelOutgoingAsks();
    const client = this.getClient(serverUrl, this.clientServerUrl !== serverUrl);
    await this.saveConfig({ ...this.config, serverUrl });
    await client.connect({
      deviceToken,
      hostname: this.getHostname(),
      preferredNodeName: this.getHostname(),
      session: this.registration(ctx),
    });
    this.lastPresenceKey = this.presenceKey(ctx);
    this.attachClient(client);
    if (client.credential) await saveCredential(serverUrl, client.credential, this.paths);
    return this.notify(ctx, `joined node ${client.nodeName ?? "unknown-node"}, session ${client.sessionId ?? "unknown-session"}`, "info");
  }

  private async list(): Promise<string> {
    if (this.latestCtx) this.syncCurrentPresence(this.latestCtx);
    const client = this.requireConnected();
    const sessions = await client.listSessions();
    if (sessions.length === 0) return "No online sessions.";
    return formatSessionList(sessions, client.sessionId, this.latestCtx?.cwd);
  }

  private async sendCommand(rest: string, ctx: AgentComContext): Promise<string> {
    const [target, text] = splitN(rest, 2);
    if (!target || !text) return "Usage: /com send <target> <message>";
    return this.sendTo(target, text, undefined, ctx);
  }

  private async sendTo(target: string | undefined, text: string, attachments?: Attachment[], ctx?: AgentComContext, replyTo?: string): Promise<string> {
    return (await this.sendToResult(target, text, attachments, ctx, replyTo)).text;
  }

  private async sendToResult(target: string | undefined, text: string, attachments?: Attachment[], ctx?: AgentComContext, replyTo?: string): Promise<ActionResult> {
    if (!target) return fail("Missing target.");
    if (!text) return fail("Missing message.");
    const client = this.requireConnected();
    if (this.latestCtx) this.syncCurrentPresence(this.latestCtx);
    const sessions = await client.listSessions();
    const resolved = resolveTarget(sessions, target);
    if (!resolved.found) return fail(resolved.reason);
    if (resolved.sessionId === client.sessionId) return fail("Cannot message the current session");
    if (!replyTo && this.config.confirmSend && ctx?.hasUI && ctx.ui?.confirm) {
      const confirmed = await ctx.ui.confirm("Send Message", `Send to "${target}":\n\n${text}${formatAttachments(attachments)}`);
      if (!confirmed) return fail("Message cancelled by user");
    }
    const result = await client.send(resolved.sessionId, { text, attachments, replyTo });
    if (!result.delivered) return fail(`Message to "${target}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { delivered: false, reason: result.reason, messageId: result.id });
    if (replyTo) this.replyTracker.markReplied(replyTo);
    ctx?.appendEntry?.("agentcom_sent", { to: target, message: { text, attachments, replyTo }, messageId: result.id, timestamp: this.now() });
    return ok(`Message sent to ${target}`, { delivered: true, messageId: result.id });
  }

  private async askCommand(rest: string, ctx: AgentComContext): Promise<string> {
    const [target, text] = splitN(rest, 2);
    return this.ask(target, text, ctx);
  }

  private async ask(target: string | undefined, text: string, ctx: AgentComContext, attachments?: Attachment[]): Promise<string> {
    return (await this.askResult(target, text, ctx, attachments)).text;
  }

  private async askResult(target: string | undefined, text: string, ctx: AgentComContext, attachments?: Attachment[], signal?: AbortSignal): Promise<ActionResult> {
    if (!target) return fail("Usage: /com ask <target> <message>");
    if (!text) return fail("Missing message.");
    if ([...this.outgoingAsks.values()].some((ask) => ask.status === "waiting")) return fail("Already waiting for a reply");
    if (signal?.aborted) return fail("Cancelled");
    const client = this.requireConnected();
    this.syncCurrentPresence(ctx);
    const sessions = await client.listSessions();
    const resolved = resolveTarget(sessions, target);
    if (!resolved.found) return fail(resolved.reason);
    if (resolved.sessionId === client.sessionId) return fail("Cannot message the current session");
    const messageId = `m-${this.randomId()}`;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    const clearPendingAsk = () => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      onAbort = null;
      this.outgoingAsks.delete(messageId);
    };
    const replyPromise = new Promise<{ type: "reply"; message: AgentComMessage } | { type: "timeout" } | { type: "cancelled" }>((resolve) => {
      onAbort = () => {
        clearPendingAsk();
        resolve({ type: "cancelled" });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => {
        const ask = this.outgoingAsks.get(messageId);
        if (ask) ask.status = "timed_out";
        clearPendingAsk();
        resolve({ type: "timeout" });
      }, ctx.askTimeoutMs ?? 10 * 60 * 1000);
      this.outgoingAsks.set(messageId, {
        to: target,
        targetSessionId: resolved.sessionId,
        messageId,
        text,
        status: "waiting",
        resolve: (message) => {
          clearPendingAsk();
          resolve({ type: "reply", message });
        },
        cancel: () => {
          clearPendingAsk();
          resolve({ type: "cancelled" });
        },
      });
    });
    let ack: SendResult;
    try {
      ack = await client.send(resolved.sessionId, { text, attachments, expectsReply: true, messageId });
    } catch (error) {
      clearPendingAsk();
      throw error;
    }
    if (!ack.delivered) {
      clearPendingAsk();
      return fail(formatSendResult(ack), { delivered: false, reason: ack.reason, messageId: ack.id });
    }
    ctx.appendEntry?.("agentcom_sent", { to: target, message: { text, attachments, expectsReply: true }, messageId: ack.id, timestamp: this.now() });
    const reply = await replyPromise;
    if (reply.type === "cancelled") return fail("Cancelled", { delivered: true, cancelled: true, messageId });
    if (reply.type === "timeout") return fail(`ask delivered but timed out waiting for reply (${messageId})`, { delivered: true, timedOut: true, messageId });
    const message = reply.message;
    ctx.appendEntry?.("agentcom_received", { from: target, message: { text: message.content.text, attachments: message.content.attachments }, messageId: message.id, timestamp: message.timestamp });
    return ok(`**Reply from ${target}:**\n${message.content.text}${formatAttachments(message.content.attachments)}`, { delivered: true, messageId, replyId: message.id });
  }

  private async reply(text: string, replyTo?: string, to?: string): Promise<string> {
    return (await this.replyResult(text, replyTo, to)).text;
  }

  private async replyResult(text: string, replyTo?: string, to?: string): Promise<ActionResult> {
    if (!text) return fail("Usage: /com reply <message>");
    const client = this.requireConnected();
    const ask = this.replyTracker.resolveReplyTarget({ replyTo, to }, this.now());
    const result = await client.send(ask.from.id, { text, replyTo: ask.message.id });
    if (!result.delivered) return fail(formatSendResult(result), { delivered: false, reason: result.reason, messageId: result.id });
    this.replyTracker.markReplied(ask.message.id);
    this.latestCtx?.appendEntry?.("agentcom_sent", { to: ask.from.address, message: { text, replyTo: ask.message.id }, messageId: result.id, timestamp: this.now() });
    return ok(`Reply sent to ${ask.from.address}`, { delivered: true, messageId: result.id, replyTo: ask.message.id });
  }

  private async pending(): Promise<string> {
    const incoming = this.replyTracker.listPending(this.now());
    const outgoing = [...this.outgoingAsks.values()].filter((ask) => ask.status === "waiting");
    if (incoming.length === 0 && outgoing.length === 0) return "No pending asks.";
    return [
      ...incoming.map((ask) => `incoming ${ask.message.id} from ${ask.from.address} (${ask.from.nodeName}) waiting: ${summarize(ask.message.content.text)}`),
      ...outgoing.map((ask) => `outgoing ${ask.messageId} to ${ask.to} waiting: ${summarize(ask.text)}`),
    ].join("\n");
  }

  private async status(): Promise<string> {
    if (this.latestCtx) this.syncCurrentPresence(this.latestCtx);
    const serverUrl = this.config.serverUrl ? normalizeServerUrl(this.config.serverUrl) : "not configured";
    const connected = this.client?.isConnected() ?? false;
    let count = 0;
    if (connected && this.client) count = (await this.client.listSessions()).length;
    return [
      `server: ${serverUrl}`,
      `node: ${this.client?.nodeName ?? "not joined"}`,
      `session: ${this.client?.sessionId ?? "not connected"}`,
      `connected: ${connected ? "yes" : "no"}`,
      `online sessions: ${count}`,
    ].join("\n");
  }

  private async rename(name: string): Promise<string> {
    if (!name.trim()) return "Usage: /com rename <node_name>";
    const client = this.requireConnected();
    const nodeName = await client.renameNode(name.trim());
    if (this.config.serverUrl && client.credential) await saveCredential(this.config.serverUrl, client.credential, this.paths);
    return `renamed node ${nodeName}`;
  }

  private async leave(): Promise<string> {
    const serverUrl = this.config.serverUrl;
    this.runtimeGeneration += 1;
    this.cancelOutgoingAsks();
    this.client?.disconnect();
    this.client = null;
    this.clientServerUrl = null;
    this.unsubscribeMessage?.();
    this.unsubscribeMessage = null;
    if (serverUrl) await removeCredential(serverUrl, this.paths);
    return "left room and removed current server credential";
  }

  private async panel(ctx: AgentComContext): Promise<string> {
    const client = this.requireConnected();
    this.syncCurrentPresence(ctx);
    const allSessions = await client.listSessions();
    const currentSession = allSessions.find((session) => session.id === client.sessionId);
    const sessions = allSessions.filter((session) => session.id !== client.sessionId);
    if (!currentSession) return "Current session is missing from agentcom session list.";
    if (ctx.ui?.custom && ctx.hasUI !== false && ctx.mode !== "rpc") {
      return this.panelOverlay(ctx, client, currentSession, sessions);
    }
    if (sessions.length === 0) return "No other online sessions.";
    const options = buildSessionOptions(sessions, client.sessionId, ctx.cwd);
    const labels = options.map((option) => option.label);
    const selected = await ctx.ui?.select?.("agentcom sessions", labels);
    if (!selected) return "No target selected.";
    const session = options[labels.indexOf(selected)]?.session;
    if (!session) return "No target selected.";
    const text = await composeMessage(ctx.ui, "Message");
    if (!text) return "No message entered.";
    const result = await client.send(session.id, { text });
    if (!result.delivered) return formatSendResult(result);
    const targetLabel = sessionResultLabel(session, duplicateSessionDisplayNames(allSessions));
    ctx.appendEntry?.("agentcom_sent", { to: targetLabel, message: { text }, messageId: result.id, timestamp: this.now() });
    return `Message sent to ${targetLabel}`;
  }

  private async panelOverlay(ctx: AgentComContext, client: ClientLike, currentSession: SessionInfo, sessions: SessionInfo[]): Promise<string> {
    const generation = this.runtimeGeneration;
    const selectedSession = await ctx.ui?.custom?.<SessionInfo | undefined>(
      (_tui, theme, keybindings, done) => new SessionListOverlay(defaultTheme(theme), defaultKeybindings(keybindings), currentSession, sessions, done),
      { overlay: true },
    ).catch(() => undefined);
    if (!this.isLiveGeneration(generation)) return "No message sent.";
    if (!selectedSession) return "No target selected.";
    const targetLabel = sessionResultLabel(selectedSession, duplicateSessionDisplayNames([currentSession, ...sessions]));

    const result = await ctx.ui?.custom?.<ComposeResult>(
      (tui, theme, keybindings, done) => new ComposeOverlay(tui, theme, keybindings, selectedSession, targetLabel, client, done),
      { overlay: true },
    ).catch(() => undefined);
    if (!this.isLiveGeneration(generation)) return "No message sent.";

    if (!result?.sent || !result.messageId || !result.text) return "No message sent.";
    ctx.appendEntry?.("agentcom_sent", {
      to: targetLabel,
      message: { text: result.text },
      messageId: result.messageId,
      timestamp: this.now(),
    });
    ctx.ui?.notify?.(`Message sent to ${targetLabel}`, "info");
    return `Message sent to ${targetLabel}`;
  }

  private isLiveGeneration(generation: number): boolean {
    return this.runtimeGeneration === generation && Boolean(this.client?.isConnected());
  }

  private cancelOutgoingAsks(): void {
    for (const ask of [...this.outgoingAsks.values()]) ask.cancel();
  }

  private attachClient(client: ClientLike): void {
    this.unsubscribeMessage?.();
    this.client = client;
    this.unsubscribeMessage = client.onMessage((from, message) => this.handleIncoming(from, message));
  }

  syncCurrentPresence(ctx: AgentComContext): void {
    if (!this.client?.isConnected()) return;
    const key = this.presenceKey(ctx);
    if (key === this.lastPresenceKey) return;
    this.client.updatePresence({
      name: ctx.sessionName?.trim() ?? "",
      model: ctx.model ?? "unknown",
      status: this.presenceStatus(ctx),
    });
    this.lastPresenceKey = key;
  }

  private handleIncoming(from: SessionInfo, message: AgentComMessage): void {
    if (message.replyTo) {
      const ask = this.outgoingAsks.get(message.replyTo);
      if (ask && ask.targetSessionId === from.id) {
        ask.resolve(message);
        return;
      }
    }
    const context = this.replyTracker.recordIncomingMessage(from, message, this.now());
    if (!this.latestCtx) return;
    if (this.latestCtx.isIdle) {
      this.replyTracker.queueTurnContext(context);
      this.renderIncoming(from, message, this.latestCtx, "steer");
    } else {
      this.replyTracker.queueTurnContext(context);
      this.pendingIncomingMessages.push({ from, message, context });
    }
  }

  private flushPendingIncoming(ctx: AgentComContext): void {
    if (this.pendingIncomingMessages.length === 0) return;
    const pending = this.pendingIncomingMessages.splice(0);
    for (const entry of pending) {
      this.renderIncoming(entry.from, entry.message, ctx, "steer");
    }
  }

  private renderIncoming(from: SessionInfo, message: AgentComMessage, ctx: AgentComContext, deliverAs: "steer" | "followUp"): void {
    const bodyText = `${message.content.text}${formatAttachments(message.content.attachments)}`;
    const details: InlineMessageDetails = {
      from,
      message,
      bodyText,
      replyCommand: this.config.replyHint === false ? undefined : replyCommandFor(message),
    };
    const text = formatInlineMessage(details);
    ctx.appendEntry?.("agentcom_message", details);
    if (ctx.sendMessage) {
      ctx.sendMessage({
        customType: "agentcom_message",
        content: formatIncomingContent(details),
        display: true,
        details,
      }, deliverAs === "followUp" ? { deliverAs: "followUp", triggerTurn: true } : { triggerTurn: true });
      return;
    }
    ctx.ui?.notify?.(text, "info");
    ctx.injectMessage?.(text, { deliverAs });
  }

  private getClient(serverUrl: string, replace = false): ClientLike {
    if (!replace && this.client && this.clientServerUrl === serverUrl) return this.client;
    const client = this.clientFactory(serverUrl);
    this.client = client;
    this.clientServerUrl = serverUrl;
    return client;
  }

  private requireConnected(): ClientLike {
    if (!this.client?.isConnected()) throw new Error("Not connected. Run /com join <ws_url> <device_token> first.");
    return this.client;
  }

  private registration(ctx: AgentComContext): SessionRegistration {
    return {
      name: ctx.sessionName,
      cwd: ctx.cwd,
      model: ctx.model ?? "unknown",
      runtime: "pi",
      pid: process.pid,
      startedAt: this.now(),
      lastActivity: this.now(),
      status: "idle",
    };
  }

  private presenceKey(ctx: AgentComContext): string {
    return JSON.stringify({
      name: ctx.sessionName?.trim() ?? "",
      model: ctx.model ?? "unknown",
      status: this.presenceStatus(ctx),
    });
  }

  private presenceStatus(ctx: AgentComContext): string {
    return this.activityStatus ?? (ctx.isIdle === false ? "working" : "idle");
  }

  private async saveConfig(config: AgentComConfig & { enabled?: boolean }): Promise<void> {
    this.config = config;
    await saveConfig(config, this.paths);
  }

  private notify(ctx: AgentComContext, message: string, type: "info" | "warning" | "error"): string {
    ctx.ui?.notify?.(message, type);
    return message;
  }

  private userError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export function normalizeAuthBaseUrl(input: string): string {
  const url = new URL(input.trim());
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (url.pathname === "/auth/device" || url.pathname === "/auth/devices") url.pathname = "";
  return url.toString().replace(/\/$/, "");
}

function splitCommand(input: string): [string, string] {
  const trimmed = input.trim();
  if (!trimmed) return ["", ""];
  const index = trimmed.search(/\s/);
  if (index < 0) return [trimmed, ""];
  return [trimmed.slice(0, index), trimmed.slice(index + 1).trim()];
}

function splitN(input: string, count: 2): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  const firstSpace = trimmed.search(/\s/);
  if (count === 2 && firstSpace >= 0) return [trimmed.slice(0, firstSpace), trimmed.slice(firstSpace + 1).trim()];
  return [trimmed];
}

function formatSessionList(sessions: SessionInfo[], currentSessionId?: string | null, currentCwd?: string): string {
  const current = currentSessionId ? sessions.find((session) => session.id === currentSessionId) : undefined;
  const others = sessions.filter((session) => session.id !== currentSessionId);
  if (!current) return [`Online sessions:`, ...sessions.map((session) => formatSessionRow(session, currentCwd, false))].join("\n");
  return [
    `Current session:`,
    formatSessionRow(current, currentCwd, true),
    `Other sessions:`,
    ...(others.length > 0 ? others.map((session) => formatSessionRow(session, currentCwd, false)) : ["No other sessions connected."]),
  ].join("\n");
}

function formatSessionRow(session: SessionInfo, currentCwd: string | undefined, isSelf: boolean): string {
  const tags = [isSelf ? "self" : undefined, currentCwd && session.cwd === currentCwd ? "same cwd" : undefined, session.status ?? "unknown"]
    .filter((tag): tag is string => Boolean(tag));
  const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
  return `• ${session.address} (${session.id}) — ${session.cwd} • ${session.runtime} • ${session.model}${suffix}`;
}

function duplicateSessionDisplayNames(sessions: SessionInfo[]): Set<string> {
  const names = sessions.map((session) => sessionDisplayName(session).toLowerCase());
  return new Set(names.filter((name, index) => names.indexOf(name) !== index));
}

function sessionResultLabel(session: SessionInfo, duplicates: Set<string>): string {
  const displayName = sessionDisplayName(session);
  return duplicates.has(displayName.toLowerCase()) ? `${displayName} (${shortSessionId(session.id)})` : displayName;
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function formatIncomingContent(details: InlineMessageDetails): string {
  const sender = details.from.address || details.from.name || details.from.id.slice(0, 8);
  const replyInstruction = details.replyCommand
    ? `\n\nTo reply, use ${details.replyCommand}. For multiple pending asks, use the agentcom tool with replyTo: "${details.message.id}".`
    : "";
  const body = details.bodyText ?? details.message.content.text;
  return `**📨 From ${sender}** (${details.from.cwd})${replyInstruction}\n\n${body}`;
}

function formatSendResult(result: SendResult): string {
  return result.delivered ? `delivered ${result.id}` : `delivery failed ${result.id}: ${result.reason ?? "unknown reason"}`;
}

function summarize(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ok(text: string, details?: Record<string, unknown>): ActionResult {
  return { ok: true, text, details };
}

function fail(text: string, details?: Record<string, unknown>): ActionResult {
  return { ok: false, text, details };
}
