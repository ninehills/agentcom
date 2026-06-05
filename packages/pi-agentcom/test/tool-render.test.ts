import { describe, expect, it } from "vitest";
import agentcomExtension from "../src/index.ts";

const theme = {
  fg(_name: string, text: string): string { return text; },
  bold(text: string): string { return text; },
};

describe("agentcom tool rendering", () => {
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
