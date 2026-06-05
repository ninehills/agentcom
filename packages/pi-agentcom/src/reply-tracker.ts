import type { AgentComMessage, SessionInfo } from "@agentcom/protocol";

export interface AgentComMessageContext {
  from: SessionInfo;
  message: AgentComMessage;
  receivedAt: number;
}

function matchesSender(context: AgentComMessageContext, target: string): boolean {
  const normalized = target.toLowerCase();
  return context.from.id === target
    || context.from.name?.toLowerCase() === normalized
    || context.from.address.toLowerCase() === normalized;
}

export class ReplyTracker {
  private readonly askTimeoutMs: number;
  private readonly pendingAsks = new Map<string, AgentComMessageContext>();
  private readonly incomingMessages: AgentComMessageContext[] = [];
  private readonly queuedTurnContexts: AgentComMessageContext[] = [];
  private currentTurnContext: AgentComMessageContext | null = null;

  constructor(askTimeoutMs = 10 * 60 * 1000) {
    this.askTimeoutMs = askTimeoutMs;
  }

  recordIncomingMessage(from: SessionInfo, message: AgentComMessage, receivedAt = Date.now()): AgentComMessageContext {
    const context = { from, message, receivedAt };
    this.incomingMessages.push(context);
    if (message.expectsReply) this.pendingAsks.set(message.id, context);
    return context;
  }

  queueTurnContext(context: AgentComMessageContext): void {
    this.queuedTurnContexts.push(context);
  }

  beginTurn(now = Date.now()): AgentComMessageContext | null {
    this.pruneExpired(now);
    this.currentTurnContext = this.queuedTurnContexts.shift() ?? null;
    return this.currentTurnContext;
  }

  endTurn(): void {
    this.currentTurnContext = null;
  }

  resolveReplyTarget(options: { replyTo?: string; to?: string } = {}, now = Date.now()): AgentComMessageContext {
    this.pruneExpired(now);
    if (options.replyTo) {
      const context = this.pendingAsks.get(options.replyTo);
      if (!context) throw new Error(`No pending ask ${options.replyTo}`);
      return context;
    }
    if (this.currentTurnContext?.message.expectsReply) return this.currentTurnContext;

    const pending = [...this.pendingAsks.values()];
    if (options.to) {
      const matches = pending.filter((context) => matchesSender(context, options.to!));
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) throw new Error(`Multiple pending asks from "${options.to}" — use replyTo.`);
      if (pending.length > 1) throw new Error(`No pending ask from "${options.to}"`);
    }
    if (pending.length === 1) return pending[0]!;
    if (pending.length === 0) throw new Error("No pending ask to reply to.");
    throw new Error("Multiple pending asks — specify replyTo.");
  }

  markReplied(replyTo: string): void {
    this.pendingAsks.delete(replyTo);
    if (this.currentTurnContext?.message.id === replyTo) this.currentTurnContext = null;
  }

  listPending(now = Date.now()): AgentComMessageContext[] {
    this.pruneExpired(now);
    return [...this.pendingAsks.values()].sort((a, b) => a.receivedAt - b.receivedAt);
  }

  listIncoming(): AgentComMessageContext[] {
    return [...this.incomingMessages];
  }

  reset(): void {
    this.pendingAsks.clear();
    this.incomingMessages.length = 0;
    this.queuedTurnContexts.length = 0;
    this.currentTurnContext = null;
  }

  private pruneExpired(now: number): void {
    for (const [messageId, context] of this.pendingAsks) {
      if (now - context.receivedAt > this.askTimeoutMs) this.pendingAsks.delete(messageId);
    }
  }
}
