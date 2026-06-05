import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { RemoteComClient } from "@agentcom/client/com-client";
import { generateDeviceKeypair, signNonce as signDeviceNonce } from "@agentcom/client/crypto";
import { AgentComRuntime } from "@agentcom/pi-agentcom";

export function createHarness({ baseUrl, runId, logPath }) {
  const logEvents = [];
  const sockets = new Set();
  const socketStates = new WeakMap();

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

  async function piRuntime(label) {
    const configHome = await mkdtemp(join(tmpdir(), `agentcom-${label}-`));
    const paths = {
      configHome,
      configPath: join(configHome, "config.json"),
      credentialsPath: join(configHome, "credentials.json"),
    };
    return {
      paths,
      runtime: new AgentComRuntime({
        paths,
        hostname: () => `${label}.local`,
        clientFactory: (serverUrl) => new RemoteComClient({
          serverUrl,
          autoReconnect: false,
          requestTimeoutMs: 10_000,
          sendAckTimeoutMs: 10_000,
          webSocketFactory: () => connectWebSocket(`AgentComRuntime:${label}`),
        }),
      }),
    };
  }

  function runtimeCtx(sessionName, ui, askTimeoutMs = 10_000) {
    return { cwd: "/repo", model: "real-test-model", sessionName, isIdle: true, askTimeoutMs, ui };
  }

  function RuntimeUi() {
    this.messages = [];
    this.inputs = [];
    this.selections = [];
    this.notify = (message) => this.messages.push(message);
    this.select = async (_title, options) => this.selections.shift() ?? options[0];
    this.editor = async () => this.inputs.shift();
    this.address = () => {
      const joined = this.messages.find((message) => message.includes("joined node"));
      const nodeName = joined?.match(/joined node ([^,]+)/)?.[1];
      return nodeName ? `pi-bob@${nodeName}` : "pi-bob";
    };
    this.addressLabel = () => {
      const address = this.address();
      const nodeName = address.includes("@") ? address.split("@").at(-1) : "pi-bob.local";
      return `${nodeName} / /repo / ${address} · pi · idle [same cwd]`;
    };
  }

  async function waitFor(predicate, reason, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(reason);
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
    socket.addEventListener("message", (event) => handleSocketMessage(socket, event));
    socket.addEventListener("error", (event) => void log("ws.error", { label, message: event.message ?? "websocket error" }));
    socket.addEventListener("close", (event) => handleSocketClose(socket, event));
    await waitForOpen(socket, label);
    await log("ws.connect.open", { label, wsUrl });
    return socket;
  }

  function handleSocketMessage(socket, event) {
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
  }

  function handleSocketClose(socket, event) {
    sockets.delete(socket);
    const state = socketStates.get(socket);
    if (state) {
      for (const waiter of state.waiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error(`websocket ${state.label} closed while waiting for message: ${event.code} ${event.reason}`));
      }
      void log("ws.close", { label: state.label, code: event.code, reason: event.reason, wasClean: event.wasClean });
    }
  }

  function waitForOpen(socket, label) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`timed out opening websocket ${label}`)), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error(`websocket ${label} failed to open`)); }, { once: true });
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
    const result = { status: response.status, headers: Object.fromEntries(response.headers), body: text };
    await log("http.response", { method, url, status: response.status, durationMs: Date.now() - startedAt, headers: result.headers, bodySnippet: text.slice(0, 500) });
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
    const keypair = await generateDeviceKeypair();
    return { privateKey: keypair.privateKeyJwk, publicKeyJwk: keypair.publicKeyJwk };
  }

  async function signNonce(privateKey, nonce) {
    return signDeviceNonce(privateKey, nonce);
  }

  async function revokeDevice(deviceId, label = "device") {
    const response = await http("POST", "/auth/revoke", new URLSearchParams({ deviceId }), {
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert(response.status === 303 || response.status === 404, `${label} revoke expected 303/404 for ${deviceId}, got ${response.status}`);
    return response;
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  async function log(event, data = {}) {
    logEvents.push({ ts: new Date().toISOString(), event, ...data });
    if (event === "step.start") console.log(`▶ ${data.name}`);
    if (event === "step.pass") console.log(`✓ ${data.name} (${data.durationMs}ms)`);
    if (event === "step.fail") console.error(`✗ ${data.name} (${data.durationMs}ms)`);
    if (logEvents.length % 10 === 0) await writeLog();
  }

  async function writeLog() {
    await writeFile(logPath, logEvents.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  }

  function closeSockets() {
    for (const socket of sockets) {
      try { socket.close(); } catch {}
    }
  }

  return {
    baseUrl,
    runId,
    logPath,
    step,
    assert,
    log,
    writeLog,
    closeSockets,
    http,
    connectWebSocket,
    nextJsonOf,
    registerClient,
    remoteClient,
    piRuntime,
    runtimeCtx,
    RuntimeUi,
    waitFor,
    onceRemoteMessage,
    issueToken,
    generateKeypair,
    signNonce,
    sessionRegistration,
    revokeDevice,
    toWsUrl: () => toWsUrl(baseUrl),
  };
}

export function normalizeBaseUrl(input) {
  const url = new URL(input);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function errorToLog(error) {
  return { name: error?.name, message: error?.message ?? String(error), stack: error?.stack };
}

function toWsUrl(input) {
  const url = new URL(input);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function maskToken(token) {
  if (!token) return token;
  return `${token.slice(0, 12)}…${token.slice(-4)}`;
}

function sanitizeMessage(message) {
  if (!message || typeof message !== "object") return message;
  return JSON.parse(JSON.stringify(message, (key, value) => key === "deviceToken" ? maskToken(value) : value));
}
