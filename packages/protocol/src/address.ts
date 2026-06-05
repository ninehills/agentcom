import type { SessionInfo } from "./types.ts";

export interface ParsedAddress {
  isId: boolean;
  sessionId?: string;
  sessionName?: string;
  nodeName?: string;
}

export type ResolveResult =
  | { found: true; sessionId: string }
  | { found: false; reason: string };

export function parseAddress(input: string): ParsedAddress {
  const value = input.trim();
  if (isSessionId(value)) return { isId: true, sessionId: value };

  const at = value.indexOf("@");
  if (at >= 0) {
    return {
      isId: false,
      sessionName: value.slice(0, at).trim(),
      nodeName: value.slice(at + 1).trim(),
    };
  }

  return { isId: false, sessionName: value };
}

export function resolveTarget(sessions: SessionInfo[], input: string): ResolveResult {
  const target = input.trim();
  if (!target) return { found: false, reason: "Target is empty." };

  const parsed = parseAddress(target);
  const matches = parsed.isId
    ? sessions.filter((session) => session.id === parsed.sessionId)
    : parsed.nodeName
      ? sessions.filter((session) => session.name === parsed.sessionName && session.nodeName === parsed.nodeName)
      : sessions.filter((session) => session.name === parsed.sessionName);

  if (matches.length === 1) return { found: true, sessionId: matches[0].id };
  if (matches.length === 0) return { found: false, reason: `No online session matches ${target}.` };

  return {
    found: false,
    reason: `Multiple sessions match ${target}: ${matches.map(formatSession).join(", ")}. Use a full address or session id.`,
  };
}

function isSessionId(input: string): boolean {
  return /^s-[A-Za-z0-9_-]+$/.test(input) || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input);
}

function formatSession(session: SessionInfo): string {
  return `${session.address} (${session.id})`;
}
