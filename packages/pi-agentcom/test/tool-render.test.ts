import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import agentcomExtension, { formatAgentComStatus } from "../src/index.ts";

const theme = {
  fg(_name: string, text: string): string { return text; },
  bold(text: string): string { return text; },
};

describe("agentcom tool rendering", () => {
  it("formats footer connection state with compact icons", () => {
    expect(formatAgentComStatus("connected s-zpk0qv3h@mbp")).toBe("● s-zpk0qv3h@mbp");
    expect(formatAgentComStatus("joined node mbp, session s-zpk0qv3h")).toBe("● s-zpk0qv3h@mbp");
    expect(formatAgentComStatus("left room and removed current server credential")).toBe("○ agentcom");
    expect(formatAgentComStatus("agentcom not configured")).toBe("⚙ agentcom");
    expect(formatAgentComStatus("Device not found or revoked")).toBe("⚠ agentcom");
  });

  it("wraps long ask replies to the available terminal width", () => {
    const tool = registeredComTool();
    const component = tool.renderResult({
      content: [{
        type: "text",
        text: "**Reply from hello@mbp:**\nCommitted current changes on main: aab1a080822bd8374082c3c53c9fa3a44eccf4a2 (`feat(pi-agentcom): improve remote messaging UX`). Validation passed: `npm test` and `npm run typecheck`. Working tree is clean.",
      }],
      details: { action: "ask" },
    }, { isPartial: false }, theme, { isError: false, expanded: false });

    const lines = component.render(104);

    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join("\n")).toContain("Working tree is clean.");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(104);
  });

  it("renders cancelled and top-level tool errors as failures", () => {
    const tool = registeredComTool();

    const cancelled = tool.renderResult({
      content: [{ type: "text", text: "Cancelled" }],
      details: { action: "ask", delivered: true, cancelled: true, messageId: "m-8721a1" },
    }, { isPartial: false }, theme, {});

    expect(cancelled.render(80).join("\n")).toContain("✗ Cancelled");

    const failed = tool.renderResult({
      content: [{ type: "text", text: "Not connected" }],
      isError: true,
    }, { isPartial: false }, theme, {});

    expect(failed.render(80).join("\n")).toContain("✗ Not connected");
  });
});

function registeredComTool() {
  let tool: any;
  agentcomExtension({
    on() {},
    registerCommand() {},
    registerTool(definition: any) { tool = definition; },
  });
  if (!tool) throw new Error("com tool was not registered");
  return tool;
}
