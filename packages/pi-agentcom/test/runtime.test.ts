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
    await expect(runtime.handleCommand("send bob hello world", ctx())).resolves.toContain("Message sent");
    expect(clients[0].sent.at(-1)).toMatchObject({ to: "s-bob", options: { text: "hello world" } });

    await expect(runtime.handleCommand("status", ctx())).resolves.toContain("online sessions: 2");
    await expect(runtime.handleCommand("rename New Node", ctx())).resolves.toContain("new-node");
    await expect(runtime.handleCommand("leave", ctx())).resolves.toContain("left");

    const store = JSON.parse(await readFile(paths.credentialsPath, "utf8"));
    expect(Object.keys(store.credentials)).toEqual(["wss://other.example/ws"]);
    expect(ui.messages.join("\n")).toContain("joined node test-node");
  });

  it("syncs local session name changes before listing remote sessions", async () => {
    const { runtime, clients, ctx } = await setup();
    await runtime.handleCommand("join wss://agentcom.example/ws com_dev_ok", ctx({ sessionName: "pi-main" }));
    clients[0].sessions = [session({ id: "s-self", name: "pi-main", nodeName: "test-node" }), bob];

    const list = await runtime.handleCommand("list", ctx({ sessionName: "hello" }));

    expect(clients[0].presenceUpdates.at(-1)).toMatchObject({ name: "hello", model: "test-model", status: "idle" });
    expect(list).toContain("hello@test-node");
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
    await expect(runtime.handleCommand("reply yes", ctx())).resolves.toContain("Reply sent");
    expect(clients[0].sent.at(-1)).toMatchObject({ to: "s-bob", options: { text: "yes", replyTo: "m-remote-ask" } });
    expect(ui.messages.join("\n")).toContain("com({ action: \"reply\", msg: \"...\", replyTo: \"m-remote-ask\" })");
    expect(entries).toContainEqual(expect.objectContaining({ type: "agentcom_message", details: expect.objectContaining({ from: bob, message: expect.objectContaining({ id: "m-remote-ask" }) }) }));
    expect(entries.at(-1)).toMatchObject({ type: "agentcom_sent", details: { message: { text: "yes", replyTo: "m-remote-ask" } } });

    await expect(runtime.handleTool({ action: "list" }, ctx())).resolves.toMatchObject({ ok: true });
    await expect(runtime.handleTool({ action: "send", to: "bob", message: "from tool" }, ctx())).resolves.toMatchObject({ ok: true });

    clients[0].sessions = [session({ id: "s-self", name: "pi-main", nodeName: "test-node" }), bob];
    await expect(runtime.handleCommand("", ctx({ hasUI: false }))).resolves.toContain("Message sent");
    expect(clients[0].sent.at(-1)).toMatchObject({ to: "s-bob", options: { text: "message from panel" } });
  });

  it("sends incoming messages through the custom renderer channel when available", async () => {
    const { runtime, clients, entries, ctx } = await setup();
    const customMessages: Array<{ message: any; options: any }> = [];
    await runtime.handleCommand("join wss://agentcom.example/ws com_dev_ok", ctx());
    runtime.handleTurnStart(ctx({
      sendMessage: (message, options) => customMessages.push({ message, options }),
      injectMessage: vi.fn(),
      ui: undefined,
    }));

    clients[0].emitMessage(bob, { id: "m-render-3", timestamp: 5, expectsReply: true, content: { text: "pretty please" } });

    expect(entries).toContainEqual(expect.objectContaining({ type: "agentcom_message" }));
    expect(customMessages.at(-1)).toMatchObject({
      message: {
        customType: "agentcom_message",
        display: true,
        content: expect.stringContaining("**📨 From bob@devbox**"),
        details: expect.objectContaining({ from: bob, message: expect.objectContaining({ id: "m-render-3" }) }),
      },
      options: { triggerTurn: true },
    });
    expect(customMessages.at(-1)?.message.content).toContain("agentcom tool");
    expect(customMessages.at(-1)?.message.content).toContain('replyTo: "m-render-3"');
  });

  it("queues busy incoming messages until the turn ends", async () => {
    const { runtime, clients, ctx } = await setup();
    const entries: Array<{ type: string; details: unknown }> = [];
    const customMessages: Array<{ message: any; options: any }> = [];
    await runtime.handleCommand("join wss://agentcom.example/ws com_dev_ok", ctx());
    runtime.handleTurnStart(ctx({
      isIdle: false,
      sendMessage: (message, options) => customMessages.push({ message, options }),
      injectMessage: vi.fn(),
      appendEntry: (type: string, details: unknown) => entries.push({ type, details }),
      ui: undefined,
    }));

    clients[0].emitMessage(bob, { id: "m-follow-up", timestamp: 6, expectsReply: true, content: { text: "hello" } });

    expect(customMessages).toHaveLength(0);
    expect(entries.filter((entry) => entry.type === "agentcom_message")).toHaveLength(0);

    runtime.handleTurnEnd();

    expect(customMessages.at(-1)).toMatchObject({
      message: { customType: "agentcom_message", content: expect.stringContaining("hello") },
      options: { triggerTurn: true },
    });

    runtime.handleTurnStart(ctx({
      sendMessage: (message, options) => customMessages.push({ message, options }),
      injectMessage: vi.fn(),
      appendEntry: (type: string, details: unknown) => entries.push({ type, details }),
      ui: undefined,
    }));

    expect(customMessages).toHaveLength(1);
    expect(entries.filter((entry) => entry.type === "agentcom_message")).toHaveLength(1);
  });

  it("keeps a queued follow-up ask as the implicit reply target without rendering it twice", async () => {
    const { runtime, clients, ctx } = await setup();
    const customMessages: Array<{ message: any; options: any }> = [];
    await runtime.handleCommand("join wss://agentcom.example/ws com_dev_ok", ctx());

    clients[0].emitMessage(bob, { id: "m-existing", timestamp: 5, expectsReply: true, content: { text: "first" } });
    runtime.handleTurnStart(ctx({
      isIdle: false,
      sendMessage: (message, options) => customMessages.push({ message, options }),
      injectMessage: vi.fn(),
      ui: undefined,
    }));
    clients[0].emitMessage(bob, { id: "m-follow-up", timestamp: 6, expectsReply: true, content: { text: "second" } });

    expect(customMessages).toHaveLength(0);
    runtime.handleTurnEnd();
    runtime.handleTurnStart(ctx({
      sendMessage: (message, options) => customMessages.push({ message, options }),
      injectMessage: vi.fn(),
      ui: undefined,
    }));

    expect(customMessages).toHaveLength(1);
    await expect(runtime.handleTool({ action: "reply", msg: "ok" }, ctx())).resolves.toMatchObject({ ok: true });
    expect(clients[0].sent.at(-1)).toMatchObject({ to: "s-bob", options: { text: "ok", replyTo: "m-follow-up" } });
  });

  it("uses the triggered incoming ask as the implicit reply target even with multiple pending asks", async () => {
    const { runtime, clients, ctx } = await setup();
    const customMessages: Array<{ message: any; options: any }> = [];
    await runtime.handleCommand("join wss://agentcom.example/ws com_dev_ok", ctx());
    runtime.handleTurnStart(ctx({
      sendMessage: (message, options) => customMessages.push({ message, options }),
      injectMessage: vi.fn(),
      ui: undefined,
    }));

    clients[0].emitMessage(bob, { id: "m-triggered", timestamp: 7, expectsReply: true, content: { text: "first ask" } });
    clients[0].emitMessage(session({ id: "s-eve", name: "eve", nodeName: "devbox" }), { id: "m-other", timestamp: 8, expectsReply: true, content: { text: "second ask" } });
    runtime.handleTurnStart(ctx({
      sendMessage: (message, options) => customMessages.push({ message, options }),
      injectMessage: vi.fn(),
      ui: undefined,
    }));

    expect(customMessages.at(0)).toMatchObject({ options: { triggerTurn: true } });
    await expect(runtime.handleTool({ action: "reply", msg: "answer current" }, ctx())).resolves.toMatchObject({ ok: true });
    expect(clients[0].sent.at(-1)).toMatchObject({ to: "s-bob", options: { text: "answer current", replyTo: "m-triggered" } });
  });

  it("allows send with replyTo to clear a pending ask like pi-intercom", async () => {
    const { runtime, clients, ctx } = await setup();
    await runtime.handleCommand("join wss://agentcom.example/ws com_dev_ok", ctx());
    clients[0].emitMessage(bob, { id: "m-send-reply", timestamp: 9, expectsReply: true, content: { text: "please answer" } });

    await expect(runtime.handleTool({ action: "send", to: "bob", msg: "answered", replyTo: "m-send-reply" }, ctx())).resolves.toMatchObject({ ok: true });

    expect(clients[0].sent.at(-1)).toMatchObject({ to: "s-bob", options: { text: "answered", replyTo: "m-send-reply" } });
    await expect(runtime.handleCommand("pending", ctx())).resolves.toBe("No pending asks.");
  });

  it("cancels tool asks through AbortSignal and clears pending state", async () => {
    const { runtime, clients, ctx } = await setup();
    await runtime.handleCommand("join wss://agentcom.example/ws com_dev_ok", ctx());
    const controller = new AbortController();

    const askPromise = runtime.handleTool({ action: "ask", to: "bob", message: "still there?" }, ctx({ askTimeoutMs: 1_000 }), controller.signal);
    await vi.waitFor(() => expect(clients[0].sent.at(-1)?.options.messageId).toBe("m-fixed"));
    controller.abort();

    await expect(askPromise).resolves.toMatchObject({ ok: false, text: "Cancelled" });
    await expect(runtime.handleCommand("pending", ctx())).resolves.toBe("No pending asks.");
  });

  it("uses pi-intercom-style custom overlays for the empty /com panel", async () => {
    const { runtime, clients, ui, entries, ctx } = await setup({ customDraft: "from overlay" });
    await runtime.handleCommand("join wss://agentcom.example/ws com_dev_ok", ctx());
    clients[0].sessions = [session({ id: "s-self", name: "pi-main", nodeName: "test-node" }), bob];

    await expect(runtime.handleCommand("", ctx({ hasUI: true }))).resolves.toContain("Message sent to bob@devbox");

    expect(ui.customCalls).toBe(2);
    expect(clients[0].sent.at(-1)).toMatchObject({ to: "s-bob", options: { text: "from overlay" } });
    expect(entries.at(-1)).toMatchObject({ type: "agentcom_sent", details: { to: "bob@devbox", message: { text: "from overlay" } } });
  });

  it("blocks self-target sends and a second ask while waiting", async () => {
    const { runtime, clients, ctx } = await setup();
    await runtime.handleCommand("join wss://agentcom.example/ws com_dev_ok", ctx());
    clients[0].sessions = [session({ id: "s-self", name: "pi-main", nodeName: "test-node" }), bob];

    await expect(runtime.handleCommand("send pi-main nope", ctx())).resolves.toContain("Cannot message the current session");
    await expect(runtime.handleTool({ action: "send", to: "pi-main", message: "nope" }, ctx())).resolves.toMatchObject({
      ok: false,
      text: "Cannot message the current session",
    });

    const askPromise = runtime.handleCommand("ask bob first?", ctx({ askTimeoutMs: 1_000 }));
    await vi.waitFor(() => expect(clients[0].sent.at(-1)?.options.messageId).toBe("m-fixed"));
    await expect(runtime.handleCommand("ask bob second?", ctx())).resolves.toContain("Already waiting for a reply");
    clients[0].emitMessage(bob, { id: "m-reply", timestamp: 2, replyTo: clients[0].sent.at(-1)!.options.messageId, content: { text: "ok" } });
    await expect(askPromise).resolves.toContain("ok");
  });
});

async function setup(options: { inputs?: string[]; selections?: string[]; customDraft?: string } = {}) {
  const configHome = await tempDir();
  const paths = { configHome, configPath: join(configHome, "config.json"), credentialsPath: join(configHome, "credentials.json") };
  const ui = new FakeUi(options.inputs ?? [], options.selections ?? [], options.customDraft);
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
  customCalls = 0;
  constructor(private inputs: string[] = [], private selections: string[] = [], private customDraft?: string) {}
  async input() { return this.inputs.shift(); }
  async select(_title: string, options: string[]) { return this.selections.shift() ?? options[0]; }
  async editor() { return this.inputs.shift(); }
  async custom<T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => { handleInput?: (data: string) => void }) {
    this.customCalls += 1;
    return await new Promise<T>((resolve) => {
      const component = factory({ requestRender() {} }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }, fakeKeybindings, resolve);
      if (this.customCalls === 1) {
        component.handleInput?.("\r");
      } else {
        component.handleInput?.(this.customDraft ?? "");
        component.handleInput?.("\r");
      }
    });
  }
  notify(message: string) { this.messages.push(message); }
  setStatus(_key: string, text: string | undefined) { if (text) this.messages.push(text); }
}

const fakeKeybindings = {
  matches(data: string, action: string) {
    if (action === "tui.select.confirm") return data === "\r" || data === "\n";
    if (action === "tui.select.cancel") return data === "\u001b";
    if (action === "tui.select.up") return data === "\u001b[A";
    if (action === "tui.select.down") return data === "\u001b[B";
    if (action === "tui.editor.deleteCharBackward") return data === "\b" || data === "\u007f";
    return false;
  },
  getKeys(action: string) {
    if (action === "tui.select.confirm") return ["Enter"];
    if (action === "tui.select.cancel") return ["Esc"];
    return [];
  },
};

class FakeClient implements ClientLike {
  sessionId: string | null = "s-self";
  nodeId: string | null = "n-self";
  nodeName: string | null = "test-node";
  credential: AgentComCredential | null = credential("d-self");
  sessions: SessionInfo[] = [alice, bob];
  connectCalls: unknown[] = [];
  sent: Array<{ to: string; options: any }> = [];
  presenceUpdates: Array<{ name?: string; status?: string; model?: string }> = [];
  connectError: Error | null = null;
  private messageHandlers = new Set<(from: SessionInfo, message: AgentComMessage) => void>();
  constructor(public serverUrl: string) {}
  async connect(options: unknown) { this.connectCalls.push(options); if (this.connectError) throw this.connectError; }
  disconnect() {}
  isConnected() { return true; }
  async listSessions() { return this.sessions; }
  async send(to: string, options: any) { this.sent.push({ to, options }); return { id: options.messageId ?? "m-sent", delivered: true }; }
  updatePresence(updates: { name?: string; status?: string; model?: string }) {
    this.presenceUpdates.push(updates);
    this.sessions = this.sessions.map((entry) => {
      if (entry.id !== this.sessionId) return entry;
      const name = updates.name === undefined ? entry.name : updates.name.trim() || entry.id;
      const model = updates.model ?? entry.model;
      const status = updates.status ?? entry.status;
      return { ...entry, name, model, status, address: `${name}@${entry.nodeName}` };
    });
  }
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
