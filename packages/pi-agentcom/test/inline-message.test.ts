import { describe, expect, it } from "vitest";
import type { AgentComMessage, SessionInfo } from "@agentcom/protocol";
import { InlineMessageComponent, replyCommandFor } from "../src/ui/inline-message.ts";

const theme = {
  fg(_name: string, text: string): string {
    return text;
  },
};

const from: SessionInfo = {
  id: "session-12345678",
  name: "sender",
  nodeId: "node-1",
  nodeName: "mbp",
  address: "sender@mbp",
  cwd: "/tmp/project",
  model: "model",
  runtime: "pi",
  pid: 1,
  startedAt: 0,
  lastActivity: 0,
  status: "idle",
};

const message: AgentComMessage = {
  id: "m-12345678",
  timestamp: 0,
  content: {
    text: "This is a long message that should use the available terminal width instead of a narrow fixed card.",
  },
};

describe("InlineMessageComponent", () => {
  it("renders at the available terminal width", () => {
    const component = new InlineMessageComponent({ from, message }, theme);

    const lines = component.render(120);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(visibleWidth(line)).toBe(120);
  });

  it("wraps long body text and reply hints instead of clipping them", () => {
    const component = new InlineMessageComponent({ from, message: { ...message, expectsReply: true }, replyCommand: replyCommandFor({ ...message, expectsReply: true }) }, theme);

    const lines = component.render(48);

    expect(lines.some((line) => line.includes("available terminal"))).toBe(true);
    expect(lines.some((line) => line.includes("To reply:"))).toBe(true);
    expect(lines.join("\n")).toContain("/com reply");
    expect(lines.join("\n")).toContain("<message>");
    for (const line of lines) expect(visibleWidth(line)).toBe(48);
  });

  it("renders attachments and reply metadata", () => {
    const component = new InlineMessageComponent({
      from,
      message: {
        ...message,
        replyTo: "m-original-message",
        content: { text: "done", attachments: [{ type: "snippet", name: "notes.md", content: "hello" }] },
      },
    }, theme);

    const lines = component.render(72);

    expect(lines.join("\n")).toContain("📎 notes.md");
    expect(lines.join("\n")).toContain("Reply to m-origin");
    for (const line of lines) expect(visibleWidth(line)).toBe(72);
  });
});

function visibleWidth(text: string): number {
  return [...text].reduce((width, char) => width + (isWide(char.codePointAt(0) ?? 0) ? 2 : 1), 0);
}

function isWide(code: number): boolean {
  return code >= 0x1100 && (
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
  );
}
