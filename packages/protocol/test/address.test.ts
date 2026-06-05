import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/types.ts";
import { parseAddress, resolveTarget } from "../src/address.ts";

describe("agentcom address resolution", () => {
  const sessions: SessionInfo[] = [
    session({ id: "s-alice01", name: "main", nodeName: "macbook" }),
    session({ id: "s-bob0001", name: "worker", nodeName: "devbox" }),
    session({ id: "s-bob0002", name: "worker", nodeName: "laptop" }),
  ];

  it("parses session ids, full addresses, and names", () => {
    expect(parseAddress("s-alice01")).toEqual({ isId: true, sessionId: "s-alice01" });
    expect(parseAddress("worker@devbox")).toEqual({ isId: false, sessionName: "worker", nodeName: "devbox" });
    expect(parseAddress("main")).toEqual({ isId: false, sessionName: "main" });
  });

  it("resolves only unambiguous targets and returns user-displayable errors", () => {
    expect(resolveTarget(sessions, "s-alice01")).toEqual({ found: true, sessionId: "s-alice01" });
    expect(resolveTarget(sessions, "worker@devbox")).toEqual({ found: true, sessionId: "s-bob0001" });
    expect(resolveTarget(sessions, "main")).toEqual({ found: true, sessionId: "s-alice01" });

    expect(resolveTarget(sessions, "worker")).toEqual({
      found: false,
      reason: "Multiple sessions match worker: worker@devbox (s-bob0001), worker@laptop (s-bob0002). Use a full address or session id.",
    });
    expect(resolveTarget(sessions, "missing")).toEqual({ found: false, reason: "No online session matches missing." });
  });
});

function session(overrides: Pick<SessionInfo, "id" | "name" | "nodeName">): SessionInfo {
  return {
    id: overrides.id,
    name: overrides.name,
    nodeId: `n-${overrides.nodeName}`,
    nodeName: overrides.nodeName,
    address: `${overrides.name}@${overrides.nodeName}`,
    cwd: "/repo",
    model: "test-model",
    runtime: "pi",
    pid: 123,
    startedAt: 1,
    lastActivity: 2,
    status: "idle",
  };
}
