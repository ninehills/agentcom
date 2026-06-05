import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("agentcom Worker", () => {
  it("answers health checks", async () => {
    const response = await fetchWorker("https://agentcom.example/");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("agentcom ok");
  });

  it("shows a helpful empty device management page", async () => {
    const devices = await fetchWorker("https://agentcom.example/auth/devices");

    expect(devices.status).toBe(200);
    const html = await devices.text();
    expect(html).toContain("agentcom devices");
    expect(html).toContain("No registered devices yet");
    expect(html).toContain("/com auth");
  });

  it("lets a browser token register a device into the room", async () => {
    const { message } = await registerClient({ name: "main", hostname: "MacBook Pro.local" });
    expect(message).toMatchObject({
      type: "register_ok",
      requestId: "req-register",
      nodeName: "macbook-pro-local",
    });
    expect(message.sessionId).toMatch(/^s-/);
    expect(message.deviceId).toMatch(/^d-/);
  });

  it("lists online sessions and delivers messages by session id", async () => {
    const alice = await registerClient({ name: "alice", hostname: "alice-box" });
    const bob = await registerClient({ name: "bob", hostname: "bob-box" });

    alice.socket.send(JSON.stringify({ type: "list", requestId: "req-list" }));
    const sessions = await nextJsonOf(alice.socket, "sessions");
    expect(sessions).toMatchObject({ type: "sessions", requestId: "req-list" });
    expect(sessions.sessions.map((session: any) => session.address)).toEqual(
      expect.arrayContaining(["alice@alice-box", "bob@bob-box"]),
    );

    const sent = {
      id: "m-1",
      timestamp: 10,
      content: { text: "hello bob" },
    };
    alice.socket.send(JSON.stringify({ type: "send", to: bob.message.sessionId, msg: sent }));

    expect(await nextJson(bob.socket)).toMatchObject({
      type: "message",
      from: { address: "alice@alice-box" },
      msg: sent,
    });
    expect(await nextJson(alice.socket)).toEqual({ type: "delivered", messageId: "m-1" });
  });

  it("reconnects registered devices with a signed challenge", async () => {
    const first = await registerClient({ name: "first", hostname: "reconnect-box" });
    const socket = await connectWebSocket();

    socket.send(JSON.stringify({ type: "auth_begin", requestId: "req-begin", deviceId: first.message.deviceId }));
    const challenge = await nextJson(socket);
    expect(challenge).toMatchObject({ type: "auth_challenge", requestId: "req-begin" });

    socket.send(JSON.stringify({
      type: "auth_finish",
      requestId: "req-finish",
      deviceId: first.message.deviceId,
      signature: await signNonce(first.privateKey, challenge.nonce),
      session: sessionRegistration("reconnected"),
    }));

    expect(await nextJson(socket)).toMatchObject({
      type: "register_ok",
      requestId: "req-finish",
      deviceId: first.message.deviceId,
      nodeId: first.message.nodeId,
      nodeName: "reconnect-box",
    });
  });

  it("updates presence, renames nodes, and cleans up unregistered sessions", async () => {
    const client = await registerClient({ name: "old", hostname: "rename-box" });

    client.socket.send(JSON.stringify({ type: "presence", name: "new", status: "thinking", model: "gpt-test" }));
    client.socket.send(JSON.stringify({ type: "rename_node", requestId: "req-rename", nodeName: "Dev Box" }));
    expect(await nextJson(client.socket)).toMatchObject({ type: "node_renamed", requestId: "req-rename", nodeName: "dev-box" });

    client.socket.send(JSON.stringify({ type: "list", requestId: "req-list-after-rename" }));
    const list = await nextJson(client.socket);
    expect(list.sessions).toContainEqual(expect.objectContaining({ name: "new", nodeName: "dev-box", address: "new@dev-box", status: "thinking", model: "gpt-test" }));

    client.socket.send(JSON.stringify({ type: "unregister" }));
    client.socket.send(JSON.stringify({ type: "list", requestId: "req-after-unregister" }));
    expect(await nextJson(client.socket)).toMatchObject({ type: "error", err: "Not authenticated" });
  });

  it("rejects reused tokens, invalid signatures, and invalid send targets", async () => {
    const token = await issueToken();
    const client = await registerClient({ name: "sender", hostname: "sender-box", token });
    const secondSocket = await connectWebSocket();
    const otherKeypair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    secondSocket.send(JSON.stringify({
      type: "register_device",
      requestId: "req-reuse",
      deviceToken: token,
      hostname: "other-box",
      publicKeyJwk: await crypto.subtle.exportKey("jwk", otherKeypair.publicKey),
      session: sessionRegistration("other"),
    }));
    expect(await nextJson(secondSocket)).toMatchObject({ type: "register_failed", reason: "Invalid or expired device token" });

    const reconnect = await connectWebSocket();
    reconnect.send(JSON.stringify({ type: "auth_begin", requestId: "req-begin-bad", deviceId: client.message.deviceId }));
    const challenge = await nextJson(reconnect);
    reconnect.send(JSON.stringify({
      type: "auth_finish",
      requestId: "req-finish-bad",
      deviceId: client.message.deviceId,
      signature: await signNonce(otherKeypair.privateKey, challenge.nonce),
      session: sessionRegistration("bad"),
    }));
    expect(await nextJson(reconnect)).toMatchObject({ type: "auth_failed", reason: "Invalid signature" });

    client.socket.send(JSON.stringify({ type: "send", to: "not-a-session", msg: { id: "m-bad", timestamp: 1, content: { text: "bad" } } }));
    expect(await nextJson(client.socket)).toEqual({ type: "delivery_failed", messageId: "m-bad", reason: "Invalid send message" });
  });

  it("shows and revokes the current user's devices", async () => {
    const client = await registerClient({ name: "device", hostname: "device-box" });

    const devices = await fetchWorker("https://agentcom.example/auth/devices");
    expect(devices.status).toBe(200);
    const html = await devices.text();
    expect(html).toContain(client.message.deviceId);
    expect(html).toContain(client.message.nodeId);
    expect(html).toContain("device-box");
    expect(html).toContain("tester@example.com");
    expect(html).toContain("Last seen");

    const revoked = await fetchWorker("https://agentcom.example/auth/revoke", {
      method: "POST",
      body: new URLSearchParams({ deviceId: client.message.deviceId }),
      redirect: "manual",
    });
    expect(revoked.status).toBe(303);

    const socket = await connectWebSocket();
    socket.send(JSON.stringify({ type: "auth_begin", requestId: "req-revoked", deviceId: client.message.deviceId }));
    expect(await nextJson(socket)).toMatchObject({ type: "auth_failed", reason: "Device not found or revoked" });
  });
});

function sessionRegistration(name: string) {
  return {
    name,
    cwd: "/repo",
    model: "test-model",
    runtime: "pi",
    pid: 123,
    startedAt: 1,
    lastActivity: 2,
    status: "idle",
  };
}

async function connectWebSocket(): Promise<WebSocket> {
  const response = await fetchWorker("https://agentcom.example/ws", {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).toBeDefined();
  socket!.accept();
  return socket!;
}

async function issueToken(): Promise<string> {
  const tokenPage = await fetchWorker("https://agentcom.example/auth/device");
  expect(tokenPage.status).toBe(200);
  const html = await tokenPage.text();
  const token = html.match(/com_dev_[A-Za-z0-9_-]+/)?.[0];
  expect(token).toBeDefined();
  return token!;
}

async function registerClient(options: { name: string; hostname: string; token?: string }) {
  const keypair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);
  const socket = await connectWebSocket();
  socket.send(JSON.stringify({
    type: "register_device",
    requestId: "req-register",
    deviceToken: options.token ?? await issueToken(),
    hostname: options.hostname,
    publicKeyJwk,
    session: sessionRegistration(options.name),
  }));
  const message = await nextJson(socket);
  expect(message.type).toBe("register_ok");
  return { socket, message, privateKey: keypair.privateKey };
}

async function signNonce(privateKey: CryptoKey, nonce: string): Promise<string> {
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(nonce));
  return base64Url(signature);
}

function base64Url(input: ArrayBuffer): string {
  const bytes = new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fetchWorker(input: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(input, init), env as any);
}

function nextJson(socket: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for message")), 1000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      resolve(JSON.parse(String(event.data)));
    }, { once: true });
  });
}

async function nextJsonOf(socket: WebSocket, type: string): Promise<any> {
  for (let i = 0; i < 10; i += 1) {
    const message = await nextJson(socket);
    if (message.type === type) return message;
  }
  throw new Error(`timed out waiting for ${type}`);
}
