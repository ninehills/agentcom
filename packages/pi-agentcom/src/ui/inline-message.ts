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
  private readonly theme?: ThemeLike;

  constructor(details: InlineMessageDetails, theme?: unknown) {
    this.details = details;
    this.theme = isThemeLike(theme) ? theme : undefined;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width < 3) return [truncateToWidth(`From ${senderName(this.details.from)}`, Math.max(0, width))];

    const lines: string[] = [];
    const bodyWidth = Math.max(1, width - 2);
    const accent = (text: string) => this.theme?.fg?.("accent", text) ?? text;
    const dim = (text: string) => this.theme?.fg?.("dim", text) ?? text;
    const row = (text = "") => {
      const clipped = truncateToWidth(text, bodyWidth, "", true);
      return `${accent("│")}${clipped}${" ".repeat(Math.max(0, bodyWidth - visibleWidth(clipped)))}${accent("│")}`;
    };

    const header = ` 📨 From: ${senderName(this.details.from)} (${this.details.from.cwd}) `;
    const headerText = truncateToWidth(header, bodyWidth, "", true);
    lines.push(accent(`╭${headerText}${"─".repeat(Math.max(0, bodyWidth - visibleWidth(headerText)))}╮`));

    const body = this.details.bodyText ?? this.details.message.content.text;
    for (const line of wrapText(body, bodyWidth)) lines.push(row(line));

    if (this.details.replyCommand) {
      lines.push(row());
      for (const line of wrapText(` ↩ To reply: ${this.details.replyCommand} or /com reply <message>`, bodyWidth)) {
        lines.push(row(dim(line)));
      }
    }

    const attachments = this.details.message.content.attachments ?? [];
    if (attachments.length > 0) {
      lines.push(row());
      for (const attachment of attachments) {
        for (const line of wrapText(` 📎 ${attachment.name}`, bodyWidth)) lines.push(row(dim(line)));
      }
    }

    if (this.details.message.replyTo && !this.details.message.expectsReply) {
      lines.push(row());
      lines.push(row(dim(` ↳ Reply to ${this.details.message.replyTo.slice(0, 8)}`)));
    }

    lines.push(accent(`╰${"─".repeat(bodyWidth)}╯`));
    return lines;
  }
}

interface ThemeLike {
  fg?: (name: string, text: string) => string;
}

function isThemeLike(theme: unknown): theme is ThemeLike {
  return typeof theme === "object" && theme !== null && ("fg" in theme ? typeof (theme as ThemeLike).fg === "function" : true);
}

function senderName(from: SessionInfo): string {
  return from.address || from.name || from.id.slice(0, 8);
}

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function visibleWidth(text: string): number {
  let width = 0;
  for (const char of text.replace(ANSI_RE, "")) width += charWidth(char);
  return width;
}

function truncateToWidth(text: string, width: number, suffix = "…", preferNoSuffix = false): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const ellipsis = preferNoSuffix ? "" : suffix;
  const target = Math.max(0, width - visibleWidth(ellipsis));
  let out = "";
  let used = 0;
  for (const char of text.replace(ANSI_RE, "")) {
    const next = charWidth(char);
    if (used + next > target) break;
    out += char;
    used += next;
  }
  return `${out}${ellipsis}`;
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const paragraphs = text.split(/\r?\n/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const token of paragraph.split(/(\s+)/)) {
      if (!token) continue;
      if (/^\s+$/.test(token)) {
        if (current && !current.endsWith(" ")) current += " ";
        continue;
      }
      const candidate = current ? `${current}${token}` : token;
      if (visibleWidth(candidate) <= width) {
        current = candidate;
        continue;
      }
      if (current.trimEnd()) lines.push(current.trimEnd());
      current = "";
      for (const chunk of splitLongToken(token, width)) {
        if (visibleWidth(chunk) === width) lines.push(chunk);
        else current = chunk;
      }
    }
    if (current.trimEnd()) lines.push(current.trimEnd());
  }
  return lines.length ? lines : [""];
}

function splitLongToken(token: string, width: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let used = 0;
  for (const char of token) {
    const next = charWidth(char);
    if (used > 0 && used + next > width) {
      chunks.push(current);
      current = "";
      used = 0;
    }
    current += char;
    used += next;
  }
  if (current) chunks.push(current);
  return chunks;
}

function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  return isWide(code) ? 2 : 1;
}

function isWide(code: number): boolean {
  return (
    code >= 0x1100 && (
      code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    )
  );
}
