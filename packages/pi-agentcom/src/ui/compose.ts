import type { AgentComUi } from "../runtime.ts";

export async function composeMessage(ui: AgentComUi | undefined, title = "Message"): Promise<string | undefined> {
  const text = await (ui?.editor?.(title, "") ?? ui?.input?.(title, ""));
  const trimmed = text?.trim();
  return trimmed || undefined;
}
