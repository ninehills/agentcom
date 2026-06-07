import { describe, expect, it } from "vitest";
import type { AgentComMessage, SessionInfo } from "@agentcom/protocol";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatInlineMessage, InlineMessageComponent, replyCommandFor } from "../src/ui/inline-message.ts";

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
  it("formats injected messages as the same bordered card", () => {
    const text = formatInlineMessage({ from, message });

    expect(text).toContain("╭ 📨 From: sender@mbp (/tmp/project) ");
    expect(text).toContain("│This is a long message");
    expect(text).toContain("╰");
    for (const line of text.split("\n")) expect(visibleWidth(line)).toBe(104);
  });

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

  it("does not over-pad rows containing default emoji presentation characters", () => {
    const component = new InlineMessageComponent({
      from,
      message: {
        ...message,
        content: { text: "P-2026-203 已更新完毕 ✅" },
      },
    }, theme);

    const lines = component.render(148);

    expect(visibleWidth("✅")).toBe(2);
    expect(lines.some((line) => line.includes("P-2026-203 已更新完毕 ✅"))).toBe(true);
    for (const line of lines) expect(visibleWidth(line)).toBe(148);
  });
});
