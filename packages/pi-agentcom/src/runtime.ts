import { hostname as osHostname } from "node:os";
import { resolveTarget, type AgentComMessage, type Attachment, type SessionInfo, type SessionRegistration } from "@agentcom/protocol";
import { RemoteComClient, type SendResult } from "@agentcom/client/com-client";
import { getConfigPaths, loadConfig, normalizeServerUrl, saveConfig, type AgentComConfig, type ConfigPaths } from "@agentcom/client/config";
import { loadCredential, removeCredential, saveCredential } from "@agentcom/client/credentials";
import type { AgentComCredential } from "@agentcom/client/credentials";
import { ReplyTracker } from "./reply-tracker.ts";
import { composeMessage } from "./ui/compose.ts";
import { buildSessionOptions } from "./ui/session-list.ts";
import { formatInlineMessage, replyCommandFor, type InlineMessageDetails } from "./ui/inline-message.ts";

export interface ClientLike {
  sessionId: string | null;
  nodeId: string | null;
  nodeName: string | null;
  credential: AgentComCredential | null;
  connect(options: unknown): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  listSessions(): Promise<SessionInfo[]>;
  send(toSessionId: string, options: { text: string; attachments?: Attachment[]; replyTo?: string; expectsReply?: boolean; messageId?: string }): Promise<SendResult>;
  renameNode(nodeName: string): Promise<string>;
  onMessage(handler: (from: SessionInfo, message: AgentComMessage) => void): () => void;
}

export interface AgentComUi {
  input?(title: string, placeholder?: string): Promise<string | undefined>;
  select?(title: string, options: string[]): Promise<string | undefined>;
  editor?(title: string, prefill?: string): Promise<string | undefined>;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
  setStatus?(key: string, text: string | undefined): void;
}

export interface AgentComContext {
  cwd: string;
  model?: string;
  sessionName?: string;
  isIdle?: boolean;
  askTimeoutMs?: number;
  ui?: AgentComUi;
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
  messageId: string;
  text: string;
  status: "waiting" | "answered" | "timed_out";
  resolve: (message: AgentComMessage) => void;
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
  private readonly replyTracker: ReplyTracker;
  private readonly outgoingAsks = new Map<string, OutgoingAsk>();

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
      this.attachClient(client);
      return `connected ${client.sessionId ?? "unknown-session"}@${client.nodeName ?? credential.nodeName}`;
    } catch (error) {
      return this.userError(error);
    }
  }

  shutdown(): void {
    this.unsubscribeMessage?.();
    this.unsubscribeMessage = null;
    this.client?.disconnect();
    this.client = null;
    this.clientServerUrl = null;
    this.replyTracker.reset();
  }

  handleTurnStart(ctx: AgentComContext): void {
    this.latestCtx = ctx;
    const context = this.replyTracker.beginTurn(this.now());
    if (context) this.renderIncoming(context.from, context.message, ctx, "steer");
  }

  handleTurnEnd(): void {
    this.replyTracker.endTurn();
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
        case "send": return await this.sendCommand(rest);
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

  async handleTool(params: ComToolParams, ctx: AgentComContext): Promise<{ ok: boolean; text: string; details?: unknown }> {
    this.latestCtx = ctx;
    try {
      const message = params.message ?? params.msg ?? "";
      let text: string;
      switch (params.action) {
        case "list": text = await this.list(); break;
        case "send": text = await this.sendTo(params.to, message, params.attachments); break;
        case "ask": text = await this.ask(params.to, message, ctx, params.attachments); break;
        case "reply": text = await this.reply(message, params.replyTo); break;
        case "pending": text = await this.pending(); break;
        case "status": text = await this.status(); break;
        default: text = `Unknown com action: ${(params as { action: string }).action}`;
      }
      return { ok: !isLikelyError(text), text, details: { action: params.action } };
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
    const client = this.getClient(serverUrl, this.clientServerUrl !== serverUrl);
    await this.saveConfig({ ...this.config, serverUrl });
    await client.connect({
      deviceToken,
      hostname: this.getHostname(),
      preferredNodeName: this.getHostname(),
      session: this.registration(ctx),
    });
    this.attachClient(client);
    if (client.credential) await saveCredential(serverUrl, client.credential, this.paths);
    return this.notify(ctx, `joined node ${client.nodeName ?? "unknown-node"}, session ${client.sessionId ?? "unknown-session"}`, "info");
  }

  private async list(): Promise<string> {
    const client = this.requireConnected();
    const sessions = await client.listSessions();
    if (sessions.length === 0) return "No online sessions.";
    return sessions.map(formatSession).join("\n");
  }

  private async sendCommand(rest: string): Promise<string> {
    const [target, text] = splitN(rest, 2);
    if (!target || !text) return "Usage: /com send <target> <message>";
    return this.sendTo(target, text);
  }

  private async sendTo(target: string | undefined, text: string, attachments?: Attachment[]): Promise<string> {
    if (!target) return "Missing target.";
    if (!text) return "Missing message.";
    const client = this.requireConnected();
    const sessions = await client.listSessions();
    const resolved = resolveTarget(sessions, target);
    if (!resolved.found) return resolved.reason;
    const result = await client.send(resolved.sessionId, { text, attachments });
    return formatSendResult(result);
  }

  private async askCommand(rest: string, ctx: AgentComContext): Promise<string> {
    const [target, text] = splitN(rest, 2);
    return this.ask(target, text, ctx);
  }

  private async ask(target: string | undefined, text: string, ctx: AgentComContext, attachments?: Attachment[]): Promise<string> {
    if (!target) return "Usage: /com ask <target> <message>";
    if (!text) return "Missing message.";
    const client = this.requireConnected();
    const sessions = await client.listSessions();
    const resolved = resolveTarget(sessions, target);
    if (!resolved.found) return resolved.reason;
    const messageId = `m-${this.randomId()}`;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const clearPendingAsk = () => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      this.outgoingAsks.delete(messageId);
    };
    const replyPromise = new Promise<AgentComMessage | null>((resolve) => {
      timeout = setTimeout(() => {
        const ask = this.outgoingAsks.get(messageId);
        if (ask) ask.status = "timed_out";
        clearPendingAsk();
        resolve(null);
      }, ctx.askTimeoutMs ?? 10 * 60 * 1000);
      this.outgoingAsks.set(messageId, {
        to: target,
        messageId,
        text,
        status: "waiting",
        resolve: (message) => {
          clearPendingAsk();
          resolve(message);
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
      return formatSendResult(ack);
    }
    const reply = await replyPromise;
    return reply ? `reply from ${target}: ${reply.content.text}` : `ask delivered but timed out waiting for reply (${messageId})`;
  }

  private async reply(text: string, replyTo?: string): Promise<string> {
    if (!text) return "Usage: /com reply <message>";
    const client = this.requireConnected();
    const ask = this.replyTracker.resolveReplyTarget({ replyTo }, this.now());
    const result = await client.send(ask.from.id, { text, replyTo: ask.message.id });
    if (!result.delivered) return formatSendResult(result);
    this.replyTracker.markReplied(ask.message.id);
    return `replied to ${ask.from.address}: ${result.id}`;
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
    const serverUrl = this.config.serverUrl ? normalizeServerUrl(this.config.serverUrl) : "not configured";
    const connected = this.client?.isConnected() ?? false;
    let count = 0;
    if (connected && this.client) count = (await this.client.listSessions()).length;
    return [
      `server: ${serverUrl}`,
      `node: ${this.client?.nodeName ?? "not joined"}`,
      `session: ${this.client?.sessionId ?? "not connected"}`,
      `connected: ${connected}`,
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
    const sessions = (await client.listSessions()).filter((session) => session.id !== client.sessionId);
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
    return formatSendResult(result);
  }

  private attachClient(client: ClientLike): void {
    this.unsubscribeMessage?.();
    this.client = client;
    this.unsubscribeMessage = client.onMessage((from, message) => this.handleIncoming(from, message));
  }

  private handleIncoming(from: SessionInfo, message: AgentComMessage): void {
    const context = this.replyTracker.recordIncomingMessage(from, message, this.now());
    if (message.replyTo) {
      const ask = this.outgoingAsks.get(message.replyTo);
      if (ask) ask.resolve(message);
    }
    if (!this.latestCtx) return;
    if (this.latestCtx.isIdle) {
      this.renderIncoming(from, message, this.latestCtx, "steer");
    } else {
      this.replyTracker.queueTurnContext(context);
      this.renderIncoming(from, message, this.latestCtx, "followUp");
    }
  }

  private renderIncoming(from: SessionInfo, message: AgentComMessage, ctx: AgentComContext, deliverAs: "steer" | "followUp"): void {
    const details: InlineMessageDetails = { from, message, replyCommand: replyCommandFor(message) };
    const text = formatInlineMessage(details);
    ctx.appendEntry?.("agentcom_message", details);
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

function formatSession(session: SessionInfo): string {
  return `${session.address} id=${session.id} node=${session.nodeName} cwd=${session.cwd} runtime=${session.runtime} status=${session.status ?? "unknown"} model=${session.model}`;
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

function isLikelyError(text: string): boolean {
  return /^(Usage:|Missing|No |Not connected|Unknown|delivery failed|Multiple sessions|Run \/com auth)/i.test(text);
}
