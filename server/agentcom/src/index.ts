import type {
  AgentComMessage,
  AuthMessage,
  AuthResponse,
  IncomingMessage,
  OutgoingMessage,
  ServerMessage,
  SessionInfo,
  SessionRegistration,
} from "@agentcom/protocol";
import { DurableObject } from "cloudflare:workers";

export interface Env {
  ROOM: DurableObjectNamespace<ComRoom>;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  DEVICE_TOKEN_HMAC_SECRET?: string;
  AGENTCOM_TEST_ACCESS_EMAIL?: string;
}

interface DeviceRecord {
  deviceId: string;
  nodeId: string;
  publicKeyJwk: JsonWebKey;
  email: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt?: number;
}

interface NodeRecord {
  nodeId: string;
  nodeName: string;
  hostname: string;
  deviceId: string;
  email: string;
  createdAt: number;
}

interface TokenRecord {
  email: string;
  expiresAt: number;
  createdAt: number;
  usedAt?: number;
}

interface SocketAttachment {
  sessionId?: string;
  session?: SessionInfo;
  deviceId?: string;
  pendingAuth?: { deviceId: string; requestId: string; nonce: string };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("agentcom ok\n", { status: 200 });
    }

    if (url.pathname === "/ws") {
      const id = env.ROOM.idFromName("default");
      return env.ROOM.get(id).fetch(request);
    }

    if (url.pathname.startsWith("/auth/")) {
      const authConfigError = validateAccessConfig(env);
      if (authConfigError) return authConfigError;

      const email = await accessEmailFromJwt(request, env);
      if (!email) return new Response("Unauthorized", { status: 401 });

      const headers = new Headers(request.headers);
      headers.set("x-agentcom-access-email", email);
      headers.delete("cf-access-jwt-assertion");
      const forwarded = new Request(request, { headers });
      const id = env.ROOM.idFromName("default");
      return env.ROOM.get(id).fetch(forwarded);
    }

    return new Response("Not found", { status: 404 });
  },
};

export class ComRoom extends DurableObject<Env> {
  private readonly sessions = new Map<string, { ws: WebSocket; session: SessionInfo; deviceId: string }>();

  constructor(private readonly roomState: DurableObjectState, private readonly roomEnv: Env) {
    super(roomState, roomEnv);
  }

  async fetch(request: Request): Promise<Response> {
    this.rehydrateSessions();
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.serializeAttachment({} satisfies SocketAttachment);
      this.roomState.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    const email = request.headers.get("x-agentcom-access-email");
    if (!email) return new Response("Unauthorized", { status: 401 });

    if (url.pathname === "/auth/device") return this.handleDeviceToken(request, email);
    if (url.pathname === "/auth/devices") return this.handleDevices(email);
    if (url.pathname === "/auth/revoke") return this.handleRevoke(request, email);
    if (url.pathname === "/auth/delete") return this.handleDeleteDevice(request, email);

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    this.rehydrateSessions();
    let message: IncomingMessage;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return send(ws, { type: "error", err: "Invalid JSON" });
    }

    if (message.type === "register_device") return this.handleRegisterDevice(ws, message);
    if (message.type === "auth_begin") return this.handleAuthBegin(ws, message);
    if (message.type === "auth_finish") return this.handleAuthFinish(ws, message);
    if (message.type === "list") return this.handleList(ws, message.requestId);
    if (message.type === "send") return this.handleSend(ws, message.to, message.msg);
    if (message.type === "presence") return this.handlePresence(ws, message);
    if (message.type === "rename_node") return this.handleRenameNode(ws, message.requestId, message.nodeName);
    if (message.type === "unregister") {
      this.removeSocketSession(ws);
      ws.serializeAttachment({} satisfies SocketAttachment);
      return;
    }

    return send(ws, { type: "error", err: "Unsupported message" });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.removeSocketSession(ws);
  }

  private async handleDeviceToken(request: Request, email: string): Promise<Response> {
    if (!this.roomEnv.DEVICE_TOKEN_HMAC_SECRET) {
      return new Response("Worker misconfigured: DEVICE_TOKEN_HMAC_SECRET secret is not set", { status: 500 });
    }

    const token = `com_dev_${randomId(24)}`;
    const tokenHash = await this.hmacToken(token);
    const now = Date.now();
    await this.roomState.storage.put<TokenRecord>(`token:${tokenHash}`, {
      email,
      createdAt: now,
      expiresAt: now + 5 * 60 * 1000,
    });

    const wsUrl = new URL(request.url);
    wsUrl.protocol = "wss:";
    wsUrl.pathname = "/ws";
    wsUrl.search = "";
    const html = `<!doctype html><title>agentcom device token</title><main><p>${escapeHtml(email)}</p><code>${token}</code><pre>/com join ${wsUrl.toString()} ${token}</pre></main>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  private async handleRegisterDevice(ws: WebSocket, message: Extract<AuthMessage, { type: "register_device" }>): Promise<void> {
    const tokenHash = await this.hmacToken(message.deviceToken);
    const token = await this.roomState.storage.get<TokenRecord>(`token:${tokenHash}`);
    const now = Date.now();
    if (!token || token.usedAt || token.expiresAt < now) {
      send<AuthResponse>(ws, { type: "register_failed", requestId: message.requestId, reason: "Invalid or expired device token" });
      return;
    }

    if (!(await canImportPublicKey(message.publicKeyJwk))) {
      send<AuthResponse>(ws, { type: "register_failed", requestId: message.requestId, reason: "Invalid public key" });
      return;
    }

    const deviceId = `d-${randomId(8)}`;
    const nodeId = `n-${randomId(8)}`;
    const nodeName = await this.allocateNodeName(message.preferredNodeName ?? message.hostname);
    const device: DeviceRecord = {
      deviceId,
      nodeId,
      publicKeyJwk: message.publicKeyJwk,
      email: token.email,
      createdAt: now,
      lastSeenAt: now,
    };
    const node: NodeRecord = {
      nodeId,
      nodeName,
      hostname: message.hostname,
      deviceId,
      email: token.email,
      createdAt: now,
    };
    await this.roomState.storage.put(`device:${deviceId}`, device);
    await this.roomState.storage.put(`node:${nodeId}`, node);
    await this.roomState.storage.put<TokenRecord>(`token:${tokenHash}`, { ...token, usedAt: now });

    const session = this.createSession(`s-${randomId(8)}`, node, message.session);
    this.addSocketSession(ws, session, deviceId);
    send<AuthResponse>(ws, { type: "register_ok", requestId: message.requestId, sessionId: session.id, deviceId, nodeId, nodeName });
    this.broadcast({ type: "session_joined", session }, session.id);
  }

  private async handleAuthBegin(ws: WebSocket, message: Extract<AuthMessage, { type: "auth_begin" }>): Promise<void> {
    const device = await this.roomState.storage.get<DeviceRecord>(`device:${message.deviceId}`);
    if (!device || device.revokedAt) {
      send<AuthResponse>(ws, { type: "auth_failed", requestId: message.requestId, reason: "Device not found or revoked" });
      return;
    }
    const nonce = `nonce_${randomId(32)}`;
    ws.serializeAttachment({ pendingAuth: { deviceId: message.deviceId, requestId: message.requestId, nonce } } satisfies SocketAttachment);
    send<AuthResponse>(ws, { type: "auth_challenge", requestId: message.requestId, nonce });
  }

  private async handleAuthFinish(ws: WebSocket, message: Extract<AuthMessage, { type: "auth_finish" }>): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | undefined;
    if (!attachment?.pendingAuth || attachment.pendingAuth.deviceId !== message.deviceId) {
      send<AuthResponse>(ws, { type: "auth_failed", requestId: message.requestId, reason: "No pending auth" });
      return;
    }

    const device = await this.roomState.storage.get<DeviceRecord>(`device:${message.deviceId}`);
    if (!device || device.revokedAt) {
      send<AuthResponse>(ws, { type: "auth_failed", requestId: message.requestId, reason: "Device not found or revoked" });
      return;
    }
    if (!(await verifySignature(device.publicKeyJwk, attachment.pendingAuth.nonce, message.signature))) {
      send<AuthResponse>(ws, { type: "auth_failed", requestId: message.requestId, reason: "Invalid signature" });
      return;
    }

    const node = await this.roomState.storage.get<NodeRecord>(`node:${device.nodeId}`);
    if (!node) {
      send<AuthResponse>(ws, { type: "auth_failed", requestId: message.requestId, reason: "Device not found or revoked" });
      return;
    }

    await this.roomState.storage.put<DeviceRecord>(`device:${device.deviceId}`, { ...device, lastSeenAt: Date.now() });
    const session = this.createSession(`s-${randomId(8)}`, node, message.session);
    this.addSocketSession(ws, session, device.deviceId);
    send<AuthResponse>(ws, { type: "register_ok", requestId: message.requestId, sessionId: session.id, deviceId: device.deviceId, nodeId: node.nodeId, nodeName: node.nodeName });
    this.broadcast({ type: "session_joined", session }, session.id);
  }

  private handleList(ws: WebSocket, requestId: string): void {
    if (!this.requireSession(ws)) return;
    send(ws, { type: "sessions", requestId, sessions: [...this.sessions.values()].map((entry) => entry.session) });
  }

  private handleSend(ws: WebSocket, to: string, msg: AgentComMessage): void {
    const sender = this.requireSession(ws);
    const messageId = isRecord(msg) && typeof msg.id === "string" ? msg.id : "unknown";
    if (!sender) {
      send(ws, { type: "delivery_failed", messageId, reason: "Sender not found" });
      return;
    }

    if (!to.startsWith("s-") || !isValidMessage(msg)) {
      send(ws, { type: "delivery_failed", messageId, reason: "Invalid send message" });
      return;
    }
    if (to === sender.session.id) {
      send(ws, { type: "delivery_failed", messageId, reason: "Cannot message self" });
      return;
    }
    const target = this.sessions.get(to);
    if (!target) {
      send(ws, { type: "delivery_failed", messageId, reason: "Session not found" });
      return;
    }

    send(target.ws, { type: "message", from: sender.session, msg });
    send(ws, { type: "delivered", messageId: msg.id });
  }

  private handlePresence(ws: WebSocket, updates: { name?: string; status?: string; model?: string }): void {
    const entry = this.requireSession(ws);
    if (!entry) return;
    const nextName = updates.name === undefined ? entry.session.name : updates.name.trim() || entry.session.id;
    const session: SessionInfo = {
      ...entry.session,
      name: nextName,
      status: updates.status ?? entry.session.status,
      model: updates.model ?? entry.session.model,
      lastActivity: Date.now(),
    };
    session.address = `${session.name}@${session.nodeName}`;
    this.addSocketSession(ws, session, entry.deviceId);
    this.broadcast({ type: "presence_update", session }, session.id);
  }

  private async handleRenameNode(ws: WebSocket, requestId: string, requestedName: string): Promise<void> {
    const entry = this.requireSession(ws);
    if (!entry) return;
    const node = await this.roomState.storage.get<NodeRecord>(`node:${entry.session.nodeId}`);
    if (!node) return send(ws, { type: "error", err: "Node not found" });
    const nodeName = await this.allocateNodeName(requestedName, node.nodeId);
    await this.roomState.storage.put<NodeRecord>(`node:${node.nodeId}`, { ...node, nodeName });

    for (const current of [...this.sessions.values()]) {
      if (current.session.nodeId !== node.nodeId) continue;
      const session = { ...current.session, nodeName, address: `${current.session.name}@${nodeName}` };
      this.addSocketSession(current.ws, session, current.deviceId);
    }

    send(ws, { type: "node_renamed", requestId, nodeId: node.nodeId, nodeName });
  }

  private async handleDevices(email: string): Promise<Response> {
    const devices = await this.roomState.storage.list<DeviceRecord>({ prefix: "device:" });
    const nodes = await this.roomState.storage.list<NodeRecord>({ prefix: "node:" });
    const nodesById = new Map([...nodes.values()].map((node) => [node.nodeId, node]));
    const visibleDevices = [...devices.values()]
      .filter((device) => device.email === email)
      .sort((a, b) => b.createdAt - a.createdAt);
    const rows = visibleDevices
      .map((device) => {
        const node = nodesById.get(device.nodeId);
        const status = device.revokedAt ? "revoked" : "active";
        const createdAt = new Date(device.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
        const lastSeenAt = new Date(device.lastSeenAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
        const revokedAt = device.revokedAt ? new Date(device.revokedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) : null;
        const action = device.revokedAt
          ? `<form method="post" action="/auth/delete"><input type="hidden" name="deviceId" value="${escapeHtml(device.deviceId)}"><button class="danger" type="submit" onclick="return confirm('Delete this revoked device permanently?')">Delete permanently</button></form>`
          : `<form method="post" action="/auth/revoke"><input type="hidden" name="deviceId" value="${escapeHtml(device.deviceId)}"><button type="submit" onclick="return confirm('Revoke this device?')">Revoke</button></form>`;
        return `<li data-device-id="${escapeHtml(device.deviceId)}" class="device-row ${status}">
          <div class="device-main"><strong>${escapeHtml(node?.nodeName ?? "unknown-node")}</strong><p>${escapeHtml(node?.hostname ?? "unknown hostname")}</p></div>
          <dl>
            <div><dt>Device ID</dt><dd>${escapeHtml(device.deviceId)}</dd></div>
            <div><dt>Node ID</dt><dd>${escapeHtml(device.nodeId)}</dd></div>
            <div><dt>Email</dt><dd>${escapeHtml(device.email)}</dd></div>
            <div><dt>Created</dt><dd>${escapeHtml(createdAt)} UTC</dd></div>
            <div><dt>Last seen</dt><dd>${escapeHtml(lastSeenAt)} UTC</dd></div>
            ${revokedAt ? `<div><dt>Revoked</dt><dd>${escapeHtml(revokedAt)} UTC</dd></div>` : ""}
          </dl>
          <div class="device-actions"><span>${status}</span>${action}</div>
        </li>`;
      })
      .join("");
    const content = rows || `<section class="empty"><div>⌁</div><h2>No registered devices yet</h2><p>Run <code>/com auth</code>, sign in, then use the generated <code>/com join</code> command to add this machine.</p></section>`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>agentcom devices</title><style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f4ef; color: #15130f; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at top left, #fff7df, transparent 34rem), #f6f4ef; }
      main { width: min(920px, calc(100vw - 32px)); margin: 48px auto; }
      header { margin-bottom: 18px; }
      .eyebrow { margin: 0 0 8px; color: #8d6d30; font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
      h1 { margin: 0; font-size: clamp(32px, 7vw, 56px); line-height: .95; letter-spacing: -.05em; }
      .panel { border: 1px solid #ded6c6; border-radius: 28px; background: rgba(255, 252, 245, .88); box-shadow: 0 24px 80px rgba(59, 43, 15, .14); overflow: hidden; }
      .empty { padding: 64px 32px; text-align: center; }
      .empty div { width: 72px; height: 72px; margin: 0 auto 20px; display: grid; place-items: center; border-radius: 24px; background: #15130f; color: #ffd166; font-size: 42px; }
      h2 { margin: 0 0 10px; font-size: 24px; letter-spacing: -.03em; }
      p { margin: 0; color: #645b4d; line-height: 1.6; }
      code { padding: 2px 6px; border-radius: 8px; background: #eee5d4; color: #21180c; }
      ul { list-style: none; margin: 0; padding: 10px; }
      .device-row { display: grid; grid-template-columns: minmax(180px, .8fr) 1.6fr auto; gap: 18px; align-items: start; padding: 18px; border-radius: 20px; }
      .device-row + .device-row { margin-top: 8px; }
      .device-row.active { background: #fffaf0; }
      .device-row.revoked { background: #eee9df; color: #766e62; }
      .device-main strong { display: block; font-size: 18px; letter-spacing: -.03em; }
      .device-main p { margin-top: 4px; }
      dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 18px; margin: 0; }
      dt { color: #8a7d68; font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
      dd { margin: 3px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-wrap: anywhere; }
      .device-actions { display: grid; gap: 10px; justify-items: end; }
      .device-row span { border-radius: 999px; padding: 6px 10px; background: #e7f8df; color: #315b23; font-size: 12px; font-weight: 800; text-transform: uppercase; }
      .device-row.revoked span { background: #ded8ce; color: #6f675d; }
      button { border: 0; border-radius: 999px; padding: 9px 14px; background: #15130f; color: #fffaf0; font-weight: 800; cursor: pointer; }
      button.danger { background: #8a241f; }
      @media (max-width: 760px) { body { place-items: start center; } main { margin: 24px auto; } .device-row, dl { grid-template-columns: 1fr; } .device-actions { justify-items: start; } }
    </style></head><body><main><header><p class="eyebrow">agentcom devices</p><h1>Registered devices</h1></header><div class="panel">${rows ? `<ul>${content}</ul>` : content}</div></main></body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  private async handleRevoke(request: Request, email: string): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const form = await request.formData();
    const deviceId = String(form.get("deviceId") ?? "");
    const device = await this.roomState.storage.get<DeviceRecord>(`device:${deviceId}`);
    if (!device || device.email !== email) return new Response("Not found", { status: 404 });

    await this.roomState.storage.put<DeviceRecord>(`device:${deviceId}`, { ...device, revokedAt: Date.now() });
    for (const entry of [...this.sessions.values()]) {
      if (entry.deviceId === deviceId) {
        this.removeSocketSession(entry.ws);
        entry.ws.close(1008, "Device revoked");
      }
    }
    return new Response(null, { status: 303, headers: { location: "/auth/devices" } });
  }

  private async handleDeleteDevice(request: Request, email: string): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const form = await request.formData();
    const deviceId = String(form.get("deviceId") ?? "");
    const device = await this.roomState.storage.get<DeviceRecord>(`device:${deviceId}`);
    if (!device || device.email !== email) return new Response("Not found", { status: 404 });
    if (!device.revokedAt) return new Response("Only revoked devices can be deleted", { status: 409 });

    for (const entry of [...this.sessions.values()]) {
      if (entry.deviceId === deviceId) {
        this.removeSocketSession(entry.ws);
        entry.ws.close(1008, "Device deleted");
      }
    }
    await this.roomState.storage.delete(`device:${deviceId}`);
    await this.roomState.storage.delete(`node:${device.nodeId}`);
    return new Response(null, { status: 303, headers: { location: "/auth/devices" } });
  }

  private createSession(sessionId: string, node: NodeRecord, registration: SessionRegistration): SessionInfo {
    const name = registration.name?.trim() || sessionId;
    return {
      id: sessionId,
      name,
      nodeId: node.nodeId,
      nodeName: node.nodeName,
      address: `${name}@${node.nodeName}`,
      cwd: registration.cwd,
      model: registration.model,
      runtime: registration.runtime,
      pid: registration.pid,
      startedAt: registration.startedAt,
      lastActivity: registration.lastActivity,
      status: registration.status,
    };
  }

  private addSocketSession(ws: WebSocket, session: SessionInfo, deviceId: string): void {
    ws.serializeAttachment({ sessionId: session.id, session, deviceId } satisfies SocketAttachment);
    this.sessions.set(session.id, { ws, session, deviceId });
  }

  private removeSocketSession(ws: WebSocket): void {
    const attachment = ws.deserializeAttachment() as SocketAttachment | undefined;
    if (!attachment?.sessionId) return;
    this.sessions.delete(attachment.sessionId);
    this.broadcast({ type: "session_left", sessionId: attachment.sessionId });
  }

  private rehydrateSessions(): void {
    for (const ws of this.roomState.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as SocketAttachment | undefined;
      if (attachment?.sessionId && attachment.session && !this.sessions.has(attachment.sessionId)) {
        this.sessions.set(attachment.sessionId, { ws, session: attachment.session, deviceId: attachment.deviceId ?? "" });
      }
    }
  }

  private broadcast(message: ServerMessage, exceptSessionId?: string): void {
    for (const [sessionId, entry] of this.sessions) {
      if (sessionId !== exceptSessionId) send(entry.ws, message);
    }
  }

  private requireSession(ws: WebSocket): { ws: WebSocket; session: SessionInfo; deviceId: string } | null {
    const attachment = ws.deserializeAttachment() as SocketAttachment | undefined;
    if (!attachment?.sessionId) {
      send(ws, { type: "error", err: "Not authenticated" });
      return null;
    }
    const entry = this.sessions.get(attachment.sessionId);
    if (!entry) {
      send(ws, { type: "error", err: "Not authenticated" });
      return null;
    }
    return entry;
  }

  private async allocateNodeName(input: string, currentNodeId?: string): Promise<string> {
    const base = normalizeNodeName(input);
    const nodes = await this.roomState.storage.list<NodeRecord>({ prefix: "node:" });
    const used = new Set([...nodes.values()].filter((node) => node.nodeId !== currentNodeId).map((node) => node.nodeName));
    if (!used.has(base)) return base;
    for (let i = 0; i < 10; i += 1) {
      const candidate = `${base}-${randomId(4)}`;
      if (!used.has(candidate)) return candidate;
    }
    return `${base}-${randomId(8)}`;
  }

  private async hmacToken(token: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.roomEnv.DEVICE_TOKEN_HMAC_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
    return base64Url(signature);
  }

}

function send<T extends OutgoingMessage>(ws: WebSocket, message: T): void {
  ws.send(JSON.stringify(message));
}

function normalizeNodeName(input: string): string {
  const normalized = input.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "node";
}

function randomId(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function base64Url(input: ArrayBuffer): string {
  const bytes = new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): ArrayBuffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function canImportPublicKey(publicKeyJwk: JsonWebKey): Promise<boolean> {
  try {
    await crypto.subtle.importKey("jwk", publicKeyJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return true;
  } catch {
    return false;
  }
}

async function verifySignature(publicKeyJwk: JsonWebKey, nonce: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("jwk", publicKeyJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, base64UrlDecode(signature), new TextEncoder().encode(nonce));
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidMessage(value: unknown): value is AgentComMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.timestamp === "number" &&
    isRecord(value.content) &&
    typeof value.content.text === "string"
  );
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

function validateAccessConfig(env: Env): Response | null {
  if (env.AGENTCOM_TEST_ACCESS_EMAIL) return null;

  const missing = [
    isConfiguredValue(env.TEAM_DOMAIN) ? null : "TEAM_DOMAIN",
    isConfiguredValue(env.POLICY_AUD) ? null : "POLICY_AUD",
  ].filter(Boolean);

  if (missing.length === 0) return null;

  return new Response(`Worker misconfigured: ${missing.join(", ")} must be set for /auth/* Access JWT validation`, { status: 500 });
}

function isConfiguredValue(value: string | undefined): value is string {
  return Boolean(value && value.trim() && !value.includes("<") && !value.includes(">"));
}

async function accessEmailFromJwt(request: Request, env: Env): Promise<string | null> {
  if (env.AGENTCOM_TEST_ACCESS_EMAIL) return env.AGENTCOM_TEST_ACCESS_EMAIL;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]))) as { kid?: string; alg?: string };
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]))) as { aud?: string | string[]; iss?: string; email?: string; exp?: number };
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return null;
  const expectedIssuer = env.TEAM_DOMAIN.replace(/\/$/, "");
  const validIssuer = payload.iss === expectedIssuer || payload.iss === `${expectedIssuer}/cdn-cgi/access`;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (header.alg !== "RS256" || !header.kid || !validIssuer || !aud.includes(env.POLICY_AUD) || !payload.email) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;

  const certsResponse = await fetch(`${expectedIssuer}/cdn-cgi/access/certs`);
  const certs = (await certsResponse.json()) as { keys?: JsonWebKey[] };
  const jwk = certs.keys?.find((key) => (key as JsonWebKey & { kid?: string }).kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  return verified ? payload.email : null;
}
