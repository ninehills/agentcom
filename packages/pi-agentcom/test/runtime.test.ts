import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentComMessage, SessionInfo, SessionRegistration } from "@agentcom/protocol";
import type { AgentComCredential } from "@agentcom/client/credentials";
import { saveConfig } from "@agentcom/client/config";
import { saveCredential } from "@agentcom/client/credentials";
import { AgentComRuntime, normalizeAuthBaseUrl, type AgentComContext, type ClientLike } from "../src/runtime.ts";

const privateKeyJwk = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" } as JsonWebKey;

const alice = session({ id: "s-alice", name: "alice", nodeName: "mac" });
const bob = session({ id: "s-bob", name: "bob", nodeName: "devbox" });

it("normalizes auth base URLs without device paths", () => {
  expect(normalizeAuthBaseUrl("https://agentcom.example/auth/device")).toBe("https://agentcom.example");
  expect(normalizeAuthBaseUrl("https://agentcom.example/auth/devices/")).toBe("https://agentcom.example");
  expect(normalizeAuthBaseUrl("https://agentcom.example/base/")).toBe("https://agentcom.example/base");
});

describe("AgentComRuntime commands", () => {
  it("auth saves only the Worker base URL and points to /auth/device", async () => {
    const { runtime, ui, paths, ctx } = await setup({ inputs: ["https://agentcom.example/auth/device"] });

    await expect(runtime.handleCommand("auth", ctx())).resolves.toContain("/auth/device");

    expect(ui.messages.at(-1)).toContain("https://agentcom.example/auth/device");
    expect(JSON.parse(await readFile(paths.configPath, "utf8"))).toMatchObject({ authUrl: "https://agentcom.example" });
  });

  it("joins, saves current server credential, lists/sends/status/renames/leaves without deleting other server credentials", async () => {
    const { runtime, clients, ui, paths, ctx } = await setup();
    await saveCredential("wss://other.example/ws", credential("d-other"), paths);

    await expect(runtime.handleCommand("join wss://agentcom.example/ws com_dev_ok", ctx())).resolves.toContain("joined");
    expect(clients[0].connectCalls[0]).toMatchObject({ deviceToken: "com_dev_ok", hostname: expect.any(String), session: { runtime: "pi" } });

    await expect(runtime.handleCommand("list", ctx())).resolves.toContain("bob@devbox");
    await expect(runtime.handleCommand("send bob hello world", ctx())).resolves.toContain("delivered");
    expect(clients[0].sent.at(-1)).toMatchObject({ to: "s-bob", options: { text: "hello world" } });

    await expect(runtime.handleCommand("status", ctx())).resolves.toContain("online sessions: 2");
    await expect(runtime.handleCommand("rename New Node", ctx())).resolves.toContain("new-node");
    await expect(runtime.handleCommand("leave", ctx())).resolves.toContain("left");

    const store = JSON.parse(await readFile(paths.credentialsPath, "utf8"));
    expect(Object.keys(store.credentials)).toEqual(["wss://other.example/ws"]);
    expect(ui.messages.join("\n")).toContain("joined node test-node");
  });

  it("auto-connects only the configured serverUrl credential on startup", async () => {
    const { runtime, clients, paths, ctx } = await setup();
    await saveConfig({ serverUrl: "wss://configured.example/ws", autoJoin: true }, paths);
    await saveCredential("wss://configured.example/ws", credential("d-configured"), paths);
    await saveCredential("wss://other.example/ws", credential("d-other"), paths);

    await runtime.start(ctx());

    expect(clients).toHaveLength(1);
    expect(clients[0].connectCalls[0]).toMatchObject({ deviceId: "d-configured" });
  });

  it("returns user-readable errors for missing authUrl, disconnected send, ambiguous target, expired token and revoked device", async () => {
    const { runtime, clients, ctx } = await setup();
    await expect(runtime.handleCommand("device", ctx())).resolves.toContain("Run /com auth first");
    await expect(runtime.handleCommand("send bob hello", ctx())).resolves.toContain("Not connected");

    await runtime.handleCommand("join wss://agentcom.example/ws com_dev_ok", ctx());
    clients[0].sessions = [bob, session({ id: "s-bob2", name: "bob", nodeName: "laptop" })];
    await expect(runtime.handleCommand("send bob hello", ctx())).resolves.toContain("Multiple sessions match bob");

    clients[0].connectError = new Error("Invalid or expired device token");
    await expect(runtime.handleCommand("join wss://agentcom.example/ws expired", ctx())).resolves.toContain("Invalid or expired device token");

    clients[0].connectError = new Error("Device not found or revoked");
    await expect(runtime.start(ctx())).resolves.toContain("Device not found or revoked");
  });

  it("asks, records incoming pending asks, replies, exposes tool actions, and panel sends selected draft", async () => {
    const { runtime, clients, ui, entries, ctx } = await setup({ inputs: ["message from panel"], selections: ["devbox / /repo / bob@devbox · pi · idle [same cwd]"] });
    await runtime.handleCommand("join wss://agentcom.example/ws com_dev_ok", ctx());

    const askPromise = runtime.handleCommand("ask bob can you check?", ctx({ askTimeoutMs: 1_000 }));
    await vi.waitFor(() => expect(clients[0].sent.at(-1)?.options.messageId).toBe("m-fixed"));
    clients[0].emitMessage(bob, { id: "m-reply", timestamp: 2, replyTo: clients[0].sent.at(-1)!.options.messageId, content: { text: "sure" } });
    await expect(askPromise).resolves.toContain("sure");

    clients[0].emitMessage(bob, { id: "m-remote-ask", timestamp: 3, expectsReply: true, content: { text: "please reply" } });
    await expect(runtime.handleCommand("pending", ctx())).resolves.toContain("please reply");
    await expect(runtime.handleCommand("reply yes", ctx())).resolves.toContain("replied");
    expect(clients[0].sent.at(-1)).toMatchObject({ to: "s-bob", options: { text: "yes", replyTo: "m-remote-ask" } });
    expect(ui.messages.join("\n")).toContain("com({ action: \"reply\", msg: \"...\", replyTo: \"m-remote-ask\" })");
    expect(entries.at(-1)).toMatchObject({ type: "agentcom_message", details: { from: bob, message: { id: "m-remote-ask" } } });

    await expect(runtime.handleTool({ action: "list" }, ctx())).resolves.toMatchObject({ ok: true });
    await expect(runtime.handleTool({ action: "send", to: "bob", message: "from tool" }, ctx())).resolves.toMatchObject({ ok: true });

    await expect(runtime.handleCommand("", ctx())).resolves.toContain("delivered");
    expect(clients[0].sent.at(-1)).toMatchObject({ to: "s-bob", options: { text: "message from panel" } });
  });
});

async function setup(options: { inputs?: string[]; selections?: string[] } = {}) {
  const configHome = await tempDir();
  const paths = { configHome, configPath: join(configHome, "config.json"), credentialsPath: join(configHome, "credentials.json") };
  const ui = new FakeUi(options.inputs ?? [], options.selections ?? []);
  const entries: Array<{ type: string; details: unknown }> = [];
  const clients: FakeClient[] = [];
  const runtime = new AgentComRuntime({
    paths,
    clientFactory: (serverUrl) => {
      const client = new FakeClient(serverUrl);
      clients.push(client);
      return client;
    },
    now: () => 1000,
    randomId: () => "fixed",
    hostname: () => "test-host",
  });
  const ctx = (overrides: Partial<AgentComContext> = {}) => ({
    cwd: "/repo",
    model: "test-model",
    sessionName: "pi-main",
    isIdle: true,
    ui,
    injectMessage: vi.fn(),
    appendEntry: (type: string, details: unknown) => entries.push({ type, details }),
    ...overrides,
  });
  return { runtime, ui, clients, paths, entries, ctx };
}

class FakeUi {
  messages: string[] = [];
  constructor(private inputs: string[] = [], private selections: string[] = []) {}
  async input() { return this.inputs.shift(); }
  async select(_title: string, options: string[]) { return this.selections.shift() ?? options[0]; }
  async editor() { return this.inputs.shift(); }
  notify(message: string) { this.messages.push(message); }
  setStatus(_key: string, text: string | undefined) { if (text) this.messages.push(text); }
}

class FakeClient implements ClientLike {
  sessionId: string | null = "s-self";
  nodeId: string | null = "n-self";
  nodeName: string | null = "test-node";
  credential: AgentComCredential | null = credential("d-self");
  sessions: SessionInfo[] = [alice, bob];
  connectCalls: unknown[] = [];
  sent: Array<{ to: string; options: any }> = [];
  connectError: Error | null = null;
  private messageHandlers = new Set<(from: SessionInfo, message: AgentComMessage) => void>();
  constructor(public serverUrl: string) {}
  async connect(options: unknown) { this.connectCalls.push(options); if (this.connectError) throw this.connectError; }
  disconnect() {}
  isConnected() { return true; }
  async listSessions() { return this.sessions; }
  async send(to: string, options: any) { this.sent.push({ to, options }); return { id: options.messageId ?? "m-sent", delivered: true }; }
  async renameNode() { this.nodeName = "new-node"; this.credential = { ...credential("d-self"), nodeName: "new-node" }; return "new-node"; }
  onMessage(handler: (from: SessionInfo, message: AgentComMessage) => void) { this.messageHandlers.add(handler); return () => this.messageHandlers.delete(handler); }
  emitMessage(from: SessionInfo, message: AgentComMessage) { for (const handler of this.messageHandlers) handler(from, message); }
}

function credential(deviceId: string): AgentComCredential {
  return { deviceId, nodeId: `n-${deviceId}`, nodeName: "node", privateKeyJwk };
}

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

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentcom-pi-test-"));
}
