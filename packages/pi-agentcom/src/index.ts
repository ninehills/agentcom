import { AgentComRuntime, type AgentComContext, type ComToolParams } from "./runtime.ts";
import { InlineMessageComponent, type InlineMessageDetails } from "./ui/inline-message.ts";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

const comToolParameters = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "send", "ask", "reply", "pending", "status"], description: "agentcom action" },
    to: { type: "string", description: "Target session name, full address, or session id" },
    message: { type: "string", description: "Message text" },
    msg: { type: "string", description: "Alias for message, convenient for reply prompts" },
    replyTo: { type: "string", description: "Original message id to reply to" },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

export default function agentcomExtension(pi: any) {
  const runtime = new AgentComRuntime();
  let latestPiCtx: any = null;
  let presenceTimer: ReturnType<typeof setInterval> | null = null;

  const toCtx = (ctx: any): AgentComContext => {
    latestPiCtx = ctx;
    return {
      cwd: ctx.cwd ?? process.cwd(),
      model: ctx.model ? `${ctx.model.provider ?? ""}${ctx.model.provider ? "/" : ""}${ctx.model.id ?? "unknown"}` : "unknown",
      sessionName: typeof pi.getSessionName === "function" ? pi.getSessionName() : undefined,
      isIdle: typeof ctx.isIdle === "function" ? ctx.isIdle() : ctx.isIdle,
      hasUI: ctx.hasUI,
      mode: ctx.mode,
      ui: ctx.ui,
      sendMessage: (message, options) => {
        if (typeof pi.sendMessage === "function") pi.sendMessage(message, options);
      },
      injectMessage: (message, options) => {
        if (typeof pi.sendUserMessage === "function") pi.sendUserMessage(message, options);
      },
      appendEntry: (type, details) => {
        if (typeof pi.appendEntry === "function") pi.appendEntry(type, details);
      },
    };
  };

  const startPresencePolling = () => {
    if (presenceTimer) return;
    presenceTimer = setInterval(() => {
      if (!latestPiCtx) return;
      runtime.syncCurrentPresence(toCtx(latestPiCtx));
    }, 5_000);
    (presenceTimer as { unref?: () => void }).unref?.();
  };

  const stopPresencePolling = () => {
    if (presenceTimer) clearInterval(presenceTimer);
    presenceTimer = null;
  };

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    const result = await runtime.start(toCtx(ctx));
    startPresencePolling();
    updateAgentComStatus(ctx, result);
    if (result.startsWith("connected")) {
      ctx.ui?.notify?.(`agentcom ${result}`, "info");
    }
  });

  pi.on("turn_start", (_event: unknown, ctx: any) => {
    const currentCtx = toCtx(ctx);
    runtime.syncCurrentPresence(currentCtx);
    runtime.handleTurnStart(currentCtx);
  });
  pi.on("turn_end", () => runtime.handleTurnEnd());
  pi.on("agent_start", (_event: unknown, ctx: any) => runtime.handleAgentStart(toCtx(ctx)));
  pi.on("agent_end", (_event: unknown, ctx: any) => runtime.handleAgentEnd(toCtx(ctx)));
  pi.on("tool_execution_start", (event: { name?: string; toolName?: string; tool?: { name?: string } }, ctx: any) => {
    runtime.handleToolStart(toCtx(ctx), event.tool?.name ?? event.toolName ?? event.name ?? "unknown");
  });
  pi.on("tool_execution_end", (_event: unknown, ctx: any) => runtime.handleToolEnd(toCtx(ctx)));
  pi.on("model_select", (_event: unknown, ctx: any) => runtime.syncCurrentPresence(toCtx(ctx)));
  pi.on("session_shutdown", () => {
    stopPresencePolling();
    runtime.shutdown();
  });

  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer("agentcom_message", (message: { details?: InlineMessageDetails }, _options: unknown, theme: unknown) => {
      if (!message.details) return undefined;
      return new InlineMessageComponent(message.details, theme);
    });
  }

  pi.registerCommand("com", {
    description: "agentcom remote session communication (/com auth/join/list/send/ask/reply/pending/status/rename/device/leave)",
    handler: async (args: string, ctx: any) => {
      const result = await runtime.handleCommand(args, toCtx(ctx));
      updateAgentComStatus(ctx, result);
      ctx.ui?.notify?.(result, result.match(/error|failed|missing|not connected|unknown|multiple/i) ? "warning" : "info");
    },
  });

  pi.registerTool({
    name: "com",
    label: "agentcom",
    description: "List, send, ask, reply, view pending asks, and check status for remote agentcom sessions.",
    promptSnippet: "com: communicate with remote agentcom sessions (list/send/ask/reply/pending/status)",
    promptGuidelines: [
      "Use com when the user asks to communicate with remote agentcom sessions, send a message, ask for a reply, or reply to an agentcom ask.",
    ],
    parameters: comToolParameters,
    async execute(_toolCallId: string, params: ComToolParams, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const result = await runtime.handleTool(params, toCtx(ctx), signal);
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
        isError: !result.ok,
      };
    },
    renderCall(args: Record<string, unknown>, theme: ThemeLike) {
      const action = typeof args.action === "string" ? args.action : "com";
      const target = typeof args.to === "string" && args.to.trim() ? args.to.trim() : undefined;
      const messagePreview = previewText(args.message, 96);
      const attachmentCount = Array.isArray(args.attachments) ? args.attachments.length : 0;
      let text = theme.fg("toolTitle", theme.bold("agentcom "));
      text += theme.fg(action === "ask" ? "warning" : action === "reply" ? "success" : "accent", action);
      if (target) text += " " + theme.fg("muted", "→") + " " + theme.fg("accent", target);
      if (attachmentCount > 0) text += " " + theme.fg("dim", `(${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"})`);
      if (messagePreview) text += "\n  " + theme.fg("dim", messagePreview);
      return new TextComponent(text);
    },
    renderResult(result: { content?: Array<{ type: string; text?: string }>; details?: unknown }, context: { isPartial?: boolean }, theme: ThemeLike, renderContext: { isError?: boolean; expanded?: boolean }) {
      if (context.isPartial) return new TextComponent(theme.fg("warning", "AgentCom working..."));
      const details = result.details as { delivered?: boolean; error?: boolean; messageId?: string; reason?: string } | undefined;
      const failed = Boolean(renderContext.isError || details?.error === true || details?.delivered === false);
      let text = failed ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
      text += theme.fg(failed ? "error" : "text", firstTextContent(result));
      if (details?.messageId && !renderContext.expanded) text += theme.fg("dim", ` (${details.messageId.slice(0, 8)})`);
      if (details?.reason && renderContext.expanded) text += "\n" + theme.fg("dim", `Reason: ${details.reason}`);
      return new TextComponent(text);
    },
  });
}

function updateAgentComStatus(ctx: any, result: string): void {
  const status = formatAgentComStatus(result);
  if (status) ctx.ui?.setStatus?.("agentcom", status);
}

export function formatAgentComStatus(result: string): string | undefined {
  const text = result.trim();
  const connected = /^connected\s+(.+)$/.exec(text);
  if (connected) return `● ${connected[1]}`;

  const joined = /^joined node\s+(.+), session\s+(.+)$/.exec(text);
  if (joined) return `● ${joined[2]}@${joined[1]}`;

  if (/^left room\b/.test(text)) return "○ agentcom";
  if (text === "agentcom disabled") return "⏸ agentcom";
  if (text === "agentcom not configured") return "⚙ agentcom";
  if (/^No credential\b/.test(text)) return "○ agentcom";
  if (/Device not found|revoked|Invalid or expired|auth failed|Failed to connect|Timed out connecting/i.test(text)) return "⚠ agentcom";
  return undefined;
}

interface ThemeLike {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

class TextComponent {
  constructor(private readonly text: string) {}
  invalidate(): void {}
  render(width?: number): string[] {
    const maxWidth = typeof width === "number" && Number.isFinite(width) ? Math.max(1, Math.floor(width)) : undefined;
    const lines = this.text.split("\n");
    if (!maxWidth) return lines;
    return lines.flatMap((line) => wrapTextWithAnsi(line, maxWidth));
  }
}

function previewText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function firstTextContent(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text?.replace(/\*\*/g, "") ?? "";
}

export { AgentComRuntime, normalizeAuthBaseUrl } from "./runtime.ts";
export type { AgentComContext, AgentComUi, ClientLike, ComToolParams } from "./runtime.ts";
export { ReplyTracker } from "./reply-tracker.ts";
