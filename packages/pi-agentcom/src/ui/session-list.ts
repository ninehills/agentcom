import type { SessionInfo } from "@agentcom/protocol";

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

function compareSessions(a: SessionInfo, b: SessionInfo): number {
  return a.nodeName.localeCompare(b.nodeName)
    || a.cwd.localeCompare(b.cwd)
    || a.runtime.localeCompare(b.runtime)
    || a.address.localeCompare(b.address);
}
