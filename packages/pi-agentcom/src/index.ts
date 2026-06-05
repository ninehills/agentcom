import { AgentComRuntime, type AgentComContext, type ComToolParams } from "./runtime.ts";
import { InlineMessageComponent, type InlineMessageDetails } from "./ui/inline-message.ts";

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

  const toCtx = (ctx: any): AgentComContext => ({
    cwd: ctx.cwd ?? process.cwd(),
    model: ctx.model ? `${ctx.model.provider ?? ""}${ctx.model.provider ? "/" : ""}${ctx.model.id ?? "unknown"}` : "unknown",
    sessionName: typeof pi.getSessionName === "function" ? pi.getSessionName() : undefined,
    isIdle: ctx.isIdle,
    ui: ctx.ui,
    injectMessage: (message, options) => {
      if (typeof pi.sendUserMessage === "function") pi.sendUserMessage(message, options);
    },
    appendEntry: (type, details) => {
      if (typeof pi.appendEntry === "function") pi.appendEntry(type, details);
    },
  });

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    const result = await runtime.start(toCtx(ctx));
    if (result.startsWith("connected")) {
      ctx.ui?.notify?.(`agentcom ${result}`, "info");
      ctx.ui?.setStatus?.("agentcom", result);
    }
  });

  pi.on("turn_start", (_event: unknown, ctx: any) => runtime.handleTurnStart(toCtx(ctx)));
  pi.on("turn_end", () => runtime.handleTurnEnd());
  pi.on("session_shutdown", () => runtime.shutdown());

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
    async execute(_toolCallId: string, params: ComToolParams, _signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const result = await runtime.handleTool(params, toCtx(ctx));
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  });
}

export { AgentComRuntime, normalizeAuthBaseUrl } from "./runtime.ts";
export type { AgentComContext, AgentComUi, ClientLike, ComToolParams } from "./runtime.ts";
export { ReplyTracker } from "./reply-tracker.ts";
