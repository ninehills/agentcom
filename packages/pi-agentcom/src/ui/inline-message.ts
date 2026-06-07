import type { AgentComMessage, SessionInfo } from "@agentcom/protocol";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { defaultTheme, type ThemeLike } from "./adapters.ts";

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
  return renderInlineMessageBox(details, 104).join("\n");
}

export class InlineMessageComponent {
  private readonly details: InlineMessageDetails;
  private readonly theme?: ThemeLike;

  constructor(details: InlineMessageDetails, theme?: unknown) {
    this.details = details;
    this.theme = defaultTheme(theme);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const accent = (text: string) => this.theme?.fg("accent", text) ?? text;
    const dim = (text: string) => this.theme?.fg("dim", text) ?? text;
    return renderInlineMessageBox(this.details, width, { accent, dim });
  }
}

function senderName(from: SessionInfo): string {
  return from.address || from.name || from.id.slice(0, 8);
}

function renderInlineMessageBox(details: InlineMessageDetails, width: number, theme: { accent?: (text: string) => string; dim?: (text: string) => string } = {}): string[] {
  if (width < 3) return [truncateToWidth(`From ${senderName(details.from)}`, Math.max(0, width))];

  const lines: string[] = [];
  const bodyWidth = Math.max(1, width - 2);
  const accent = theme.accent ?? ((text: string) => text);
  const dim = theme.dim ?? ((text: string) => text);
  const row = (text = "") => {
    const clipped = truncateToWidth(text, bodyWidth, "", true);
    return `${accent("│")}${clipped}${" ".repeat(Math.max(0, bodyWidth - visibleWidth(clipped)))}${accent("│")}`;
  };

  const header = ` 📨 From: ${senderName(details.from)} (${details.from.cwd}) `;
  const headerText = truncateToWidth(header, bodyWidth, "", true);
  lines.push(accent(`╭${headerText}${"─".repeat(Math.max(0, bodyWidth - visibleWidth(headerText)))}╮`));

  const body = details.bodyText ?? details.message.content.text;
  for (const line of wrapTextWithAnsi(body, bodyWidth)) lines.push(row(line));

  if (details.replyCommand) {
    lines.push(row());
    for (const line of wrapTextWithAnsi(` ↩ To reply: ${details.replyCommand} or /com reply <message>`, bodyWidth)) {
      lines.push(row(dim(line)));
    }
    for (const line of wrapTextWithAnsi(`   Reply target: ${details.message.id}`, bodyWidth)) {
      lines.push(row(dim(line)));
    }
  }

  const attachments = details.message.content.attachments ?? [];
  if (attachments.length > 0) {
    lines.push(row());
    for (const attachment of attachments) {
      for (const line of wrapTextWithAnsi(` 📎 ${attachment.name}`, bodyWidth)) lines.push(row(dim(line)));
    }
  }

  if (details.message.replyTo && !details.message.expectsReply) {
    lines.push(row());
    lines.push(row(dim(` ↳ Reply to ${details.message.replyTo.slice(0, 8)}`)));
  }

  lines.push(accent(`╰${"─".repeat(bodyWidth)}╯`));
  return lines;
}
