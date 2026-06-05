#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteComClient } from "@agentcom/client/com-client";
import { resolveTarget } from "@agentcom/protocol";

const DEFAULT_BASE_URL = "https://agentcom-test.swulling.workers.dev";
const baseUrl = normalizeBaseUrl(process.env.AGENTCOM_BASE_URL ?? process.argv[2] ?? DEFAULT_BASE_URL);
const runId = process.env.AGENTCOM_TEST_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
const logPath = resolve(process.env.AGENTCOM_TEST_LOG ?? `logs/agentcom-real-integration-${runId}.jsonl`);
const logEvents = [];
const sockets = new Set();
const socketStates = new WeakMap();

await mkdir(dirname(logPath), { recursive: true });

try {
  await log("run.start", { baseUrl, runId, node: process.version });
  const context = { hostnamePrefix: `agentcom-it-${runId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 32)}` };

  await step("health check", async () => {
    const response = await http("GET", "/");
    assert(response.status === 200, `GET / expected 200, got ${response.status}`);
    assert(response.body.includes("agentcom ok"), "GET / body should contain agentcom ok");
  });

  await step("plain /ws requires websocket upgrade", async () => {
    const response = await http("GET", "/ws");
    assert(response.status === 426, `GET /ws expected 426, got ${response.status}`);
    assert(response.body.includes("Expected Upgrade: websocket"), "GET /ws should explain expected websocket upgrade");
  });

  const alice = await step("register alice with browser-issued token", async () => {
    return registerClient({
      name: "alice",
      hostname: `${context.hostnamePrefix}-alice.local`,
      preferredNodeName: `${context.hostnamePrefix}-alice`,
    });
  });

  await step("reject reused registration token", async () => {
    const socket = await connectWebSocket("reuse-token");
    const keypair = await generateKeypair();
    socket.send(JSON.stringify({
      type: "register_device",
      requestId: "req-reuse-token",
      deviceToken: alice.token,
      hostname: `${context.hostnamePrefix}-reuse.local`,
      publicKeyJwk: keypair.publicKeyJwk,
      session: sessionRegistration("reuse"),
    }));
    const failed = await nextJsonOf(socket, "register_failed");
    assert(failed.reason === "Invalid or expired device token", `unexpected reuse-token failure reason: ${failed.reason}`);
    socket.close();
  });

  const bob = await step("register bob with a second token", async () => {
    return registerClient({
      name: "bob",
      hostname: `${context.hostnamePrefix}-bob.local`,
      preferredNodeName: `${context.hostnamePrefix}-bob`,
    });
  });

  await step("list online sessions", async () => {
    alice.socket.send(JSON.stringify({ type: "list", requestId: "req-list" }));
    const list = await nextJsonOf(alice.socket, "sessions");
    const addresses = list.sessions.map((session) => session.address);
    assert(addresses.includes(`alice@${alice.register.nodeName}`), `sessions missing alice address; got ${addresses.join(", ")}`);
    assert(addresses.includes(`bob@${bob.register.nodeName}`), `sessions missing bob address; got ${addresses.join(", ")}`);
  });

  await step("deliver message by session id", async () => {
    const msg = { id: `m-${runId}`, timestamp: Date.now(), content: { text: "hello from real integration test" } };
    alice.socket.send(JSON.stringify({ type: "send", to: bob.register.sessionId, msg }));
    const received = await nextJsonOf(bob.socket, "message");
    assert(received.from.address === `alice@${alice.register.nodeName}`, `unexpected sender ${received.from.address}`);
    assert(received.msg.content.text === msg.content.text, "delivered message text mismatch");
    const delivered = await nextJsonOf(alice.socket, "delivered");
    assert(delivered.messageId === msg.id, `unexpected delivered ack ${JSON.stringify(delivered)}`);
  });

  await step("broadcast presence update", async () => {
    alice.socket.send(JSON.stringify({ type: "presence", name: "alice-updated", status: "thinking", model: "real-test-model" }));
    const update = await nextJsonOf(bob.socket, "presence_update");
    assert(update.session.name === "alice-updated", `unexpected presence name ${update.session.name}`);
    assert(update.session.status === "thinking", `unexpected presence status ${update.session.status}`);
    assert(update.session.model === "real-test-model", `unexpected presence model ${update.session.model}`);
  });

  const renamedNodeName = await step("rename node and verify session list reflects it", async () => {
    const requested = `${context.hostnamePrefix}-renamed`;
    alice.socket.send(JSON.stringify({ type: "rename_node", requestId: "req-rename", nodeName: requested }));
    const renamed = await nextJsonOf(alice.socket, "node_renamed");
    assert(renamed.nodeId === alice.register.nodeId, `rename node id mismatch ${renamed.nodeId}`);
    assert(renamed.nodeName === requested, `unexpected renamed nodeName ${renamed.nodeName}`);

    alice.socket.send(JSON.stringify({ type: "list", requestId: "req-list-after-rename" }));
    const list = await nextJsonOf(alice.socket, "sessions");
    assert(list.sessions.some((session) => session.id === alice.register.sessionId && session.address === `alice-updated@${requested}`), "renamed node was not reflected in session list");
    return renamed.nodeName;
  });

  await step("reconnect registered device with signed challenge", async () => {
    const reconnect = await connectWebSocket("alice-reconnect");
    reconnect.send(JSON.stringify({ type: "auth_begin", requestId: "req-auth-begin", deviceId: alice.register.deviceId }));
    const challenge = await nextJsonOf(reconnect, "auth_challenge");
    assert(typeof challenge.nonce === "string" && challenge.nonce.length > 10, "auth challenge nonce missing");
    reconnect.send(JSON.stringify({
      type: "auth_finish",
      requestId: "req-auth-finish",
      deviceId: alice.register.deviceId,
      signature: await signNonce(alice.privateKey, challenge.nonce),
      session: sessionRegistration("alice-reconnected"),
    }));
    const ok = await nextJsonOf(reconnect, "register_ok");
    assert(ok.deviceId === alice.register.deviceId, `reconnect device mismatch ${ok.deviceId}`);
    assert(ok.nodeId === alice.register.nodeId, `reconnect node mismatch ${ok.nodeId}`);
    assert(ok.nodeName === renamedNodeName, `reconnect nodeName mismatch ${ok.nodeName}`);
    reconnect.close();
  });

  await step("reject invalid reconnect signature", async () => {
    const reconnect = await connectWebSocket("bad-signature");
    const otherKeypair = await generateKeypair();
    reconnect.send(JSON.stringify({ type: "auth_begin", requestId: "req-bad-begin", deviceId: bob.register.deviceId }));
    const challenge = await nextJsonOf(reconnect, "auth_challenge");
    reconnect.send(JSON.stringify({
      type: "auth_finish",
      requestId: "req-bad-finish",
      deviceId: bob.register.deviceId,
      signature: await signNonce(otherKeypair.privateKey, challenge.nonce),
      session: sessionRegistration("bad-signature"),
    }));
    const failed = await nextJsonOf(reconnect, "auth_failed");
    assert(failed.reason === "Invalid signature", `unexpected bad signature failure: ${failed.reason}`);
    reconnect.close();
  });

  const clientDevices = await step("RemoteComClient registers, reconnects, resolves, and sends through the real Worker", async () => {
    const carol = remoteClient("carol");
    const dave = remoteClient("dave");
    try {
      const [carolToken, daveToken] = await Promise.all([issueToken(), issueToken()]);
      await Promise.all([
        carol.connect({
          deviceToken: carolToken,
          hostname: `${context.hostnamePrefix}-client-carol.local`,
          preferredNodeName: `${context.hostnamePrefix}-client-carol`,
          session: sessionRegistration("client-carol"),
        }),
        dave.connect({
          deviceToken: daveToken,
          hostname: `${context.hostnamePrefix}-client-dave.local`,
          preferredNodeName: `${context.hostnamePrefix}-client-dave`,
          session: sessionRegistration("client-dave"),
        }),
      ]);

      const sessions = await carol.listSessions();
      const resolved = resolveTarget(sessions, `client-dave@${dave.nodeName}`);
      assert(resolved.found, resolved.reason ?? "RemoteComClient could not resolve dave");
      assert(resolved.sessionId === dave.sessionId, `RemoteComClient resolved ${resolved.sessionId}, expected ${dave.sessionId}`);

      const incoming = onceRemoteMessage(dave);
      const sent = await carol.send(resolved.sessionId, {
        text: "hello from RemoteComClient real integration",
        replyTo: `root-${runId}`,
        expectsReply: true,
        messageId: `m-client-${runId}`,
      });
      assert(sent.delivered, `RemoteComClient send failed: ${sent.reason}`);
      const received = await incoming;
      assert(received.from.address === `client-carol@${carol.nodeName}`, `RemoteComClient sender mismatch ${received.from.address}`);
      assert(received.message.replyTo === `root-${runId}`, "RemoteComClient replyTo missing");
      assert(received.message.expectsReply === true, "RemoteComClient expectsReply missing");
      assert(received.message.content.text === "hello from RemoteComClient real integration", "RemoteComClient message text mismatch");

      const credential = carol.credential;
      assert(credential?.deviceId && credential.privateKeyJwk, "RemoteComClient did not expose generated credential");
      carol.disconnect();
      await carol.connect({ deviceId: credential.deviceId, privateKeyJwk: credential.privateKeyJwk, session: sessionRegistration("client-carol-reconnected") });
      assert(carol.deviceId === credential.deviceId, "RemoteComClient reconnect device mismatch");
      assert(carol.nodeId === credential.nodeId, "RemoteComClient reconnect node mismatch");

      return [carol.credential?.deviceId, dave.credential?.deviceId].filter(Boolean);
    } finally {
      carol.disconnect();
      dave.disconnect();
    }
  });

  await step("device management page includes hostname and ids", async () => {
    const response = await http("GET", "/auth/devices");
    assert(response.status === 200, `GET /auth/devices expected 200, got ${response.status}`);
    assert(response.body.includes(alice.register.deviceId), "devices page missing alice device id");
    assert(response.body.includes(alice.register.nodeId), "devices page missing alice node id");
    assert(response.body.includes(`${context.hostnamePrefix}-alice.local`), "devices page missing alice hostname");
    assert(response.body.includes("tester@example.com"), "devices page missing test email");
    assert(response.body.includes("Last seen"), "devices page missing Last seen label");
  });

  await step("revoke device and reject future reconnect", async () => {
    const response = await http("POST", "/auth/revoke", new URLSearchParams({ deviceId: alice.register.deviceId }), {
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert(response.status === 303, `POST /auth/revoke expected 303, got ${response.status}`);
    assert(response.headers.location === "/auth/devices", `unexpected revoke location ${response.headers.location}`);

    const reconnect = await connectWebSocket("revoked-reconnect");
    reconnect.send(JSON.stringify({ type: "auth_begin", requestId: "req-revoked", deviceId: alice.register.deviceId }));
    const failed = await nextJsonOf(reconnect, "auth_failed");
    assert(failed.reason === "Device not found or revoked", `unexpected revoked failure: ${failed.reason}`);
    reconnect.close();
  });

  await step("cleanup bob device", async () => {
    const response = await http("POST", "/auth/revoke", new URLSearchParams({ deviceId: bob.register.deviceId }), {
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert(response.status === 303 || response.status === 404, `cleanup revoke expected 303/404, got ${response.status}`);
  });

  await step("cleanup RemoteComClient devices", async () => {
    await Promise.all(clientDevices.map(async (deviceId) => {
      const response = await http("POST", "/auth/revoke", new URLSearchParams({ deviceId }), {
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      assert(response.status === 303 || response.status === 404, `client cleanup revoke expected 303/404 for ${deviceId}, got ${response.status}`);
    }));
  });

  await log("run.pass", { logPath });
  console.log(`PASS real integration test against ${baseUrl}`);
  console.log(`Log: ${logPath}`);
} catch (error) {
  await log("run.fail", { error: errorToLog(error), logPath });
  console.error(`FAIL real integration test against ${baseUrl}`);
  console.error(error?.stack ?? error);
  console.error(`Log: ${logPath}`);
  process.exitCode = 1;
} finally {
  for (const socket of sockets) {
    try { socket.close(); } catch {}
  }
  await writeFile(logPath, logEvents.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
}

async function step(name, fn) {
  const startedAt = Date.now();
  await log("step.start", { name });
  try {
    const result = await fn();
    await log("step.pass", { name, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    await log("step.fail", { name, durationMs: Date.now() - startedAt, error: errorToLog(error) });
    throw error;
  }
}

async function registerClient({ name, hostname, preferredNodeName }) {
  const token = await issueToken();
  const keypair = await generateKeypair();
  const socket = await connectWebSocket(name);
  socket.send(JSON.stringify({
    type: "register_device",
    requestId: `req-register-${name}`,
    deviceToken: token,
    hostname,
    preferredNodeName,
    publicKeyJwk: keypair.publicKeyJwk,
    session: sessionRegistration(name),
  }));
  await log("ws.send", { label: name, type: "register_device", requestId: `req-register-${name}`, hostname, preferredNodeName, token: maskToken(token) });
  const register = await nextJsonOf(socket, "register_ok");
  assert(register.requestId === `req-register-${name}`, `unexpected register requestId ${register.requestId}`);
  assert(register.deviceId?.startsWith("d-"), `invalid deviceId ${register.deviceId}`);
  assert(register.nodeId?.startsWith("n-"), `invalid nodeId ${register.nodeId}`);
  assert(register.nodeName === preferredNodeName, `expected nodeName ${preferredNodeName}, got ${register.nodeName}`);
  return { socket, token, privateKey: keypair.privateKey, register };
}

function remoteClient(label) {
  return new RemoteComClient({
    serverUrl: toWsUrl(baseUrl),
    autoReconnect: false,
    requestTimeoutMs: 10_000,
    sendAckTimeoutMs: 10_000,
    webSocketFactory: () => connectWebSocket(`RemoteComClient:${label}`),
  });
}

function onceRemoteMessage(client) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      off();
      reject(new Error("timed out waiting for RemoteComClient message"));
    }, 10_000);
    const off = client.onMessage((from, message) => {
      clearTimeout(timeout);
      off();
      resolve({ from, message });
    });
  });
}

async function issueToken() {
  const response = await http("GET", "/auth/device");
  assert(response.status === 200, `GET /auth/device expected 200, got ${response.status}`);
  const token = response.body.match(/com_dev_[A-Za-z0-9_-]+/)?.[0];
  assert(token, "device token not found in /auth/device HTML");
  assert(response.body.includes(toWsUrl(baseUrl)), "device token page missing expected /ws URL");
  await log("auth.token", { token: maskToken(token) });
  return token;
}

async function connectWebSocket(label) {
  const wsUrl = toWsUrl(baseUrl);
  await log("ws.connect.start", { label, wsUrl });
  const socket = new WebSocket(wsUrl);
  sockets.add(socket);
  socketStates.set(socket, { label, queue: [], waiters: [] });
  socket.addEventListener("message", (event) => {
    const state = socketStates.get(socket);
    if (!state) return;

    try {
      const message = JSON.parse(String(event.data));
      void log("ws.recv", { label: state.label, message: sanitizeMessage(message) });
      const waiter = state.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      } else {
        state.queue.push(message);
      }
    } catch (error) {
      const waiter = state.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      } else {
        void log("ws.parse_error", { label: state.label, error: errorToLog(error), data: String(event.data).slice(0, 500) });
      }
    }
  });
  socket.addEventListener("error", (event) => {
    void log("ws.error", { label, message: event.message ?? "websocket error" });
  });
  socket.addEventListener("close", (event) => {
    sockets.delete(socket);
    const state = socketStates.get(socket);
    if (state) {
      for (const waiter of state.waiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error(`websocket ${label} closed while waiting for message: ${event.code} ${event.reason}`));
      }
    }
    void log("ws.close", { label, code: event.code, reason: event.reason, wasClean: event.wasClean });
  });
  await waitForOpen(socket, label);
  await log("ws.connect.open", { label, wsUrl });
  return socket;
}

function waitForOpen(socket, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out opening websocket ${label}`)), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`websocket ${label} failed to open`));
    }, { once: true });
  });
}

async function nextJsonOf(socket, type, timeoutMs = 10_000) {
  for (let i = 0; i < 20; i += 1) {
    const message = await nextJson(socket, timeoutMs);
    if (message.type === type) return message;
    await log("ws.skip", { expectedType: type, actualType: message.type, message: sanitizeMessage(message) });
  }
  throw new Error(`timed out waiting for ${type}`);
}

function nextJson(socket, timeoutMs) {
  const state = socketStates.get(socket);
  if (!state) throw new Error("websocket was not created by connectWebSocket");
  const queued = state.queue.shift();
  if (queued) return Promise.resolve(queued);

  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timeout: undefined };
    waiter.timeout = setTimeout(() => {
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) state.waiters.splice(index, 1);
      reject(new Error("timed out waiting for websocket message"));
    }, timeoutMs);
    state.waiters.push(waiter);
  });
}

async function http(method, path, body, init = {}) {
  const url = new URL(path, baseUrl).toString();
  const requestInit = { method, body, ...init, headers: { ...(init.headers ?? {}) } };
  await log("http.request", { method, url, body: body instanceof URLSearchParams ? Object.fromEntries(body) : undefined });
  const startedAt = Date.now();
  const response = await fetch(url, requestInit);
  const text = await response.text();
  const result = {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: text,
  };
  await log("http.response", {
    method,
    url,
    status: response.status,
    durationMs: Date.now() - startedAt,
    headers: result.headers,
    bodySnippet: text.slice(0, 500),
  });
  return result;
}

function sessionRegistration(name) {
  return {
    name,
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    model: "real-integration-test",
    runtime: "pi",
    pid: process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    status: "idle",
  };
}

async function generateKeypair() {
  const keypair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    privateKey: keypair.privateKey,
    publicKeyJwk: await crypto.subtle.exportKey("jwk", keypair.publicKey),
  };
}

async function signNonce(privateKey, nonce) {
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(nonce));
  return base64Url(signature);
}

function base64Url(input) {
  const bytes = new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function normalizeBaseUrl(input) {
  const url = new URL(input);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function toWsUrl(input) {
  const url = new URL(input);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function log(event, data = {}) {
  logEvents.push({ ts: new Date().toISOString(), event, ...data });
  if (event === "step.start") console.log(`▶ ${data.name}`);
  if (event === "step.pass") console.log(`✓ ${data.name} (${data.durationMs}ms)`);
  if (event === "step.fail") console.error(`✗ ${data.name} (${data.durationMs}ms)`);
  if (logEvents.length % 10 === 0) {
    await writeFile(logPath, logEvents.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  }
}

function maskToken(token) {
  if (!token) return token;
  return `${token.slice(0, 12)}…${token.slice(-4)}`;
}

function sanitizeMessage(message) {
  if (!message || typeof message !== "object") return message;
  return JSON.parse(JSON.stringify(message, (key, value) => key === "deviceToken" ? maskToken(value) : value));
}

function errorToLog(error) {
  return { name: error?.name, message: error?.message ?? String(error), stack: error?.stack };
}
