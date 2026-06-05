import type { AgentComUi } from "../runtime.ts";
import type { AgentComMessage, Attachment, SessionInfo } from "@agentcom/protocol";
import type { SendResult } from "@agentcom/client/com-client";
import { defaultKeybindings, defaultTheme, truncateToWidth, visibleWidth, type KeybindingsLike, type ThemeLike } from "./session-list.ts";

export async function composeMessage(ui: AgentComUi | undefined, title = "Message"): Promise<string | undefined> {
  const text = await (ui?.editor?.(title, "") ?? ui?.input?.(title, ""));
  const trimmed = text?.trim();
  return trimmed || undefined;
}

export interface ComposeResult {
  sent: boolean;
  messageId?: string;
  text?: string;
}

export interface ComposeClientLike {
  send(toSessionId: string, options: { text: string; attachments?: Attachment[]; replyTo?: string; expectsReply?: boolean; messageId?: string }): Promise<SendResult>;
}

export class ComposeOverlay {
  private readonly tui: TuiLike;
  private readonly theme: ThemeLike;
  private readonly keybindings: KeybindingsLike;
  private readonly target: SessionInfo;
  private readonly targetLabel: string;
  private readonly client: ComposeClientLike;
  private readonly done: (result: ComposeResult) => void;
  private inputBuffer = "";
  private sending = false;
  private error: string | null = null;

  constructor(
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    target: SessionInfo,
    targetLabel: string,
    client: ComposeClientLike,
    done: (result: ComposeResult) => void,
  ) {
    this.tui = isTuiLike(tui) ? tui : { requestRender() {} };
    this.theme = defaultTheme(theme);
    this.keybindings = defaultKeybindings(keybindings);
    this.target = target;
    this.targetLabel = targetLabel;
    this.client = client;
    this.done = done;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.sending) return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done({ sent: false });
      return;
    }

    if (data.startsWith("\x1b") && !this.keybindings.matches(data, "tui.editor.deleteCharBackward")) return;

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.inputBuffer.trim()) void this.sendMessage();
      return;
    }

    if (this.keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      this.inputBuffer = [...this.inputBuffer].slice(0, -1).join("");
      this.tui.requestRender();
      return;
    }

    const printable = [...data].filter((char) => char >= " ").join("");
    if (printable) {
      this.inputBuffer += printable;
      this.tui.requestRender();
    }
  }

  private async sendMessage(): Promise<void> {
    this.sending = true;
    this.error = null;
    this.tui.requestRender();

    try {
      const text = this.inputBuffer.trim();
      const result = await this.client.send(this.target.id, { text });
      if (!result.delivered) {
        this.error = result.reason ?? "Message not delivered. Session may not exist or has disconnected.";
        this.sending = false;
        this.tui.requestRender();
        return;
      }
      this.done({ sent: true, messageId: result.id, text });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.sending = false;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    if (width < 3) return [truncateToWidth("Message", Math.max(0, width), "", true)];
    const innerWidth = Math.max(3, Math.min(width, 72));
    const contentWidth = Math.max(1, innerWidth - 2);
    const confirmKeys = this.keybindings.getKeys("tui.select.confirm").join("/") || "Enter";
    const cancelKeys = this.keybindings.getKeys("tui.select.cancel").join("/") || "Esc";
    const footer = `${confirmKeys}: Send • ${cancelKeys}: Close`;
    const border = (text: string) => this.theme.fg("accent", text);
    const row = (text = "") => {
      const clipped = truncateToWidth(text, contentWidth, "", true);
      return `${border("│")}${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}${border("│")}`;
    };

    const lines: string[] = [];
    lines.push(border(`╭${"─".repeat(contentWidth)}╮`));
    lines.push(row(this.theme.bold(` Send to: ${this.targetLabel}`)));
    lines.push(row(this.theme.fg("dim", ` ${this.target.cwd} • ${this.target.model}`)));
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row());

    if (this.sending) {
      lines.push(row(this.theme.fg("dim", " Sending...")));
    } else if (this.error) {
      lines.push(row(this.theme.fg("error", ` Error: ${this.error}`)));
      lines.push(row());
      lines.push(row(` > ${this.inputBuffer}█`));
    } else {
      lines.push(row(` > ${this.inputBuffer}█`));
    }

    lines.push(row());
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row(this.theme.fg("dim", ` ${footer}`)));
    lines.push(border(`╰${"─".repeat(contentWidth)}╯`));
    return lines;
  }
}

function isTuiLike(value: unknown): value is TuiLike {
  return typeof value === "object" && value !== null && typeof (value as TuiLike).requestRender === "function";
}

interface TuiLike {
  requestRender(): void;
}

export function formatAttachments(attachments: AgentComMessage["content"]["attachments"]): string {
  let text = "";
  for (const att of attachments ?? []) {
    if (att.language) {
      text += `\n\n---\n📎 ${att.name}\n~~~${att.language}\n${att.content}\n~~~`;
    } else {
      text += `\n\n---\n📎 ${att.name}\n${att.content}`;
    }
  }
  return text;
}
