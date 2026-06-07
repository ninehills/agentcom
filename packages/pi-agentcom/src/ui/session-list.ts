import type { SessionInfo } from "@agentcom/protocol";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsLike, ThemeLike } from "./adapters.ts";

export { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
export { defaultKeybindings, defaultTheme, type KeybindingsLike, type ThemeLike } from "./adapters.ts";

export interface SessionOption {
  label: string;
  session: SessionInfo;
}

export function sessionDisplayName(session: SessionInfo): string {
  return session.address || `${session.name}@${session.nodeName}`;
}

export function sessionPanelLabel(session: SessionInfo, options: { self?: boolean; sameCwd?: boolean } = {}): string {
  const tags = [options.self ? "self" : undefined, options.sameCwd ? "same cwd" : undefined]
    .filter((tag): tag is string => Boolean(tag));
  const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
  return `${session.nodeName} / ${session.cwd} / ${sessionDisplayName(session)} · ${session.runtime} · ${session.status ?? "unknown"}${suffix}`;
}

export function buildSessionOptions(sessions: SessionInfo[], currentSessionId?: string | null, currentCwd?: string): SessionOption[] {
  return [...sessions]
    .sort(compareSessions)
    .map((session) => ({
      session,
      label: sessionPanelLabel(session, {
        self: Boolean(currentSessionId && session.id === currentSessionId),
        sameCwd: Boolean(currentCwd && session.cwd === currentCwd),
      }),
    }));
}

export class SessionListOverlay {
  private readonly theme: ThemeLike;
  private readonly keybindings: KeybindingsLike;
  private readonly currentSession: SessionInfo;
  private readonly sessions: SessionInfo[];
  private readonly done: (result: SessionInfo | undefined) => void;
  private selectedIndex = 0;
  private readonly maxVisible = 8;

  constructor(
    theme: ThemeLike,
    keybindings: KeybindingsLike,
    currentSession: SessionInfo,
    sessions: SessionInfo[],
    done: (result: SessionInfo | undefined) => void,
  ) {
    this.theme = theme;
    this.keybindings = keybindings;
    this.currentSession = currentSession;
    this.sessions = sessions;
    this.done = done;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    if (this.sessions.length === 0) return;

    if (this.keybindings.matches(data, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0 ? this.sessions.length - 1 : this.selectedIndex - 1;
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down")) {
      this.selectedIndex = this.selectedIndex === this.sessions.length - 1 ? 0 : this.selectedIndex + 1;
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.done(this.sessions[this.selectedIndex]);
    }
  }

  render(width: number): string[] {
    if (width < 3) return [truncateToWidth("Sessions", Math.max(0, width), "", true)];
    const innerWidth = Math.max(3, Math.min(width, 88));
    const contentWidth = Math.max(1, innerWidth - 2);
    const confirmKeys = this.keybindings.getKeys("tui.select.confirm").join("/") || "Enter";
    const cancelKeys = this.keybindings.getKeys("tui.select.cancel").join("/") || "Esc";
    const footer = `${confirmKeys}: Message • ${cancelKeys}: Close`;
    const border = (text: string) => this.theme.fg("accent", text);
    const row = (text = "") => {
      const clipped = truncateToWidth(text, contentWidth, "", true);
      return `${border("│")}${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}${border("│")}`;
    };

    const lines: string[] = [];
    lines.push(border(`╭${"─".repeat(contentWidth)}╮`));
    lines.push(row(this.theme.bold(" Current Session")));
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row());
    lines.push(row(`  ${this.theme.fg("dim", sessionTitle(this.currentSession, { self: true }))}`));
    lines.push(row(`  ${this.theme.fg("dim", `${middleTruncate(this.currentSession.cwd, Math.max(8, contentWidth - 4))} • ${this.currentSession.model}`)}`));
    lines.push(row());
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row(this.theme.bold(" Other Sessions")));
    lines.push(row());

    if (this.sessions.length === 0) {
      lines.push(row(this.theme.fg("dim", " No other agentcom-connected sessions")));
    } else {
      const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.sessions.length - this.maxVisible));
      const endIndex = Math.min(startIndex + this.maxVisible, this.sessions.length);

      for (let index = startIndex; index < endIndex; index += 1) {
        const session = this.sessions[index];
        const isSelected = index === this.selectedIndex;
        const sameCwd = session.cwd === this.currentSession.cwd;
        const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
        const title = sessionTitle(session, { sameCwd });
        const pathText = `${middleTruncate(session.cwd, Math.max(8, contentWidth - 4))} • ${session.runtime} • ${session.model}`;

        lines.push(row(`${prefix}${isSelected ? this.theme.fg("accent", title) : title}`));
        lines.push(row(`  ${this.theme.fg("dim", pathText)}`));
        if (index < endIndex - 1) lines.push(row());
      }

      if (startIndex > 0 || endIndex < this.sessions.length) {
        lines.push(row());
        lines.push(row(this.theme.fg("dim", ` ${this.selectedIndex + 1}/${this.sessions.length}`)));
      }
    }

    lines.push(row());
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row(this.theme.fg("dim", ` ${footer}`)));
    lines.push(border(`╰${"─".repeat(contentWidth)}╯`));
    return lines;
  }
}

function compareSessions(a: SessionInfo, b: SessionInfo): number {
  return a.nodeName.localeCompare(b.nodeName)
    || a.cwd.localeCompare(b.cwd)
    || a.runtime.localeCompare(b.runtime)
    || a.address.localeCompare(b.address);
}

function sessionTitle(session: SessionInfo, options: { self?: boolean; sameCwd?: boolean } = {}): string {
  const name = sessionDisplayName(session) || "Unnamed session";
  const tags = [options.self ? "self" : undefined, options.sameCwd ? "same cwd" : undefined]
    .filter((tag): tag is string => Boolean(tag));
  const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
  return `${name} (${shortSessionId(session.id)})${suffix}`;
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function middleTruncate(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return truncateToWidth(text, maxWidth, "");
  const chars = [...text];
  const targetSideWidth = Math.max(1, Math.floor((maxWidth - 1) / 2));
  let left = "";
  for (const char of chars) {
    if (visibleWidth(left + char) > targetSideWidth) break;
    left += char;
  }
  let right = "";
  for (const char of chars.slice().reverse()) {
    if (visibleWidth(char + right) > targetSideWidth) break;
    right = char + right;
  }
  return truncateToWidth(`${left}…${right}`, maxWidth, "");
}
