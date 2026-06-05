import type { AgentComMessage, SessionInfo } from "@agentcom/protocol";

export interface InlineMessageDetails {
  from: SessionInfo;
  message: AgentComMessage;
  replyCommand?: string;
  bodyText?: string;
}

export function replyCommandFor(message: AgentComMessage): string | undefined {
  return message.expectsReply ? `com({ action: "reply", msg: "...", replyTo: "${message.id}" })` : undefined;
}

export function formatInlineMessage(details: InlineMessageDetails): string {
  const body = details.bodyText ?? details.message.content.text;
  const parts = [`agentcom message from ${details.from.address}: ${body}`];
  if (details.replyCommand) parts.push(`Reply with ${details.replyCommand} or /com reply <message>.`);
  return parts.join("\n");
}

export class InlineMessageComponent {
  private readonly details: InlineMessageDetails;
  private readonly theme?: any;

  constructor(details: InlineMessageDetails, theme?: any) {
    this.details = details;
    this.theme = theme;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const bodyWidth = Math.max(1, width - 2);
    const accent = (text: string) => this.theme?.fg?.("accent", text) ?? text;
    const dim = (text: string) => this.theme?.fg?.("dim", text) ?? text;
    const clip = (text: string) => text.length > bodyWidth ? `${text.slice(0, Math.max(0, bodyWidth - 1))}…` : text;
    const row = (text = "") => accent(`│${clip(text).padEnd(bodyWidth)}│`);
    const lines = [accent(`╭${"─".repeat(bodyWidth)}╮`)];
    lines.push(row(`📨 From: ${detailsTitle(this.details.from)}`));
    lines.push(row(this.details.bodyText ?? this.details.message.content.text));
    if (this.details.replyCommand) {
      lines.push(row());
      lines.push(row(dim(`↩ ${this.details.replyCommand}`)));
    }
    lines.push(accent(`╰${"─".repeat(bodyWidth)}╯`));
    return lines;
  }
}

function detailsTitle(from: SessionInfo): string {
  return `${from.address} (${from.cwd} · ${from.runtime} · ${from.status ?? "unknown"})`;
}
