import type {
  AgentComMessage,
  AuthResponse,
  IncomingMessage,
  ServerMessage,
  SessionInfo,
  SessionRegistration,
} from "@agentcom/protocol";
import { generateDeviceKeypair, publicKeyFromPrivateJwk, signNonce } from "./crypto.ts";
import type { AgentComCredential } from "./types.ts";

export interface ConnectOptions {
  deviceToken?: string;
  deviceId?: string;
  privateKeyJwk?: JsonWebKey;
  hostname?: string;
  preferredNodeName?: string;
  publicKeyJwk?: JsonWebKey;
  session: SessionRegistration;
}

export interface PresenceUpdates {
  name?: string;
  status?: string;
  model?: string;
}

export interface SendOptions {
  text: string;
  attachments?: AgentComMessage["content"]["attachments"];
  replyTo?: string;
  expectsReply?: boolean;
  messageId?: string;
}

export interface SendResult {
  id: string;
  delivered: boolean;
  reason?: string;
}

export type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

export interface WebSocketLike {
  readonly readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: (event: Event) => void, options?: { once?: boolean }): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void, options?: { once?: boolean }): void;
  addEventListener(type: "close", listener: (event: CloseEvent) => void, options?: { once?: boolean }): void;
  addEventListener(type: "error", listener: (event: Event) => void, options?: { once?: boolean }): void;
}

export interface RemoteComClientOptions {
  serverUrl: string;
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  sendAckTimeoutMs?: number;
  autoReconnect?: boolean;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  webSocketFactory?: (serverUrl: string) => WebSocketLike | Promise<WebSocketLike>;
  now?: () => number;
  randomId?: () => string;
}

type PendingRequest<T> = {
  accept: (message: AuthResponse | ServerMessage) => T | null;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PendingSend = {
  resolve: (value: SendResult) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const OPEN = 1;
let nextClientId = 0;

export class RemoteComClient {
  sessionId: string | null = null;
  nodeId: string | null = null;
  nodeName: string | null = null;
  deviceId: string | null = null;
  credential: AgentComCredential | null = null;
  state: ConnectionState = "idle";

  private readonly requestTimeoutMs: number;
  private readonly sendAckTimeoutMs: number;
  private readonly connectionTimeoutMs: number;
  private readonly autoReconnect: boolean;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly webSocketFactory: (serverUrl: string) => WebSocketLike | Promise<WebSocketLike>;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly clientId = ++nextClientId;
  private readonly requests = new Map<string, PendingRequest<unknown>>();
  private readonly sends = new Map<string, PendingSend>();
  private readonly messageHandlers = new Set<(from: SessionInfo, message: AgentComMessage) => void>();
  private readonly serverMessageHandlers = new Set<(message: ServerMessage | AuthResponse) => void>();
  private socket: WebSocketLike | null = null;
  private manualClose = false;
  private reconnectOptions: ConnectOptions | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private readonly options: RemoteComClientOptions;

  constructor(options: RemoteComClientOptions) {
    this.options = options;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 10_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.sendAckTimeoutMs = options.sendAckTimeoutMs ?? 10_000;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 500;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomId;
  }

  async connect(options: ConnectOptions): Promise<void> {
    this.manualClose = false;
    this.clearReconnectTimer();
    this.clearPending(new Error("Connection replaced"));
    if (this.socket && this.isSocketOpen()) this.socket.close(1000, "reconnect");

    this.state = this.state === "reconnecting" ? "reconnecting" : "connecting";
    const socket = await this.openSocket();
    this.socket = socket;
    this.attachSocket(socket);

    try {
      if (options.deviceToken) await this.registerDevice(options);
      else await this.authenticateDevice(options);
      this.state = "connected";
      this.reconnectAttempt = 0;
    } catch (error) {
      this.state = "closed";
      try { socket.close(1008, "auth failed"); } catch {}
      throw error;
    }
  }

  disconnect(): void {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.clearPending(new Error("Disconnected"));
    if (this.socket && this.isSocketOpen()) {
      try { this.sendRaw({ type: "unregister" }); } catch {}
      this.socket.close(1000, "client disconnect");
    }
    this.socket = null;
    this.sessionId = null;
    this.state = "closed";
  }

  isConnected(): boolean {
    return this.state === "connected" && this.isSocketOpen();
  }

  async listSessions(): Promise<SessionInfo[]> {
    this.requireConnected();
    const requestId = this.nextRequestId("list");
    const promise = this.waitForRequest(requestId, (message) => {
      if (message.type === "sessions" && message.requestId === requestId) return message.sessions;
      if (message.type === "error") throw new Error(message.err);
      return null;
    });
    this.sendRaw({ type: "list", requestId });
    return promise;
  }

  async send(toSessionId: string, options: SendOptions): Promise<SendResult> {
    this.requireConnected();
    const id = options.messageId ?? this.nextRequestId("m");
    const msg: AgentComMessage = {
      id,
      timestamp: this.now(),
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      content: { text: options.text, attachments: options.attachments },
    };

    const promise = new Promise<SendResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.sends.delete(id);
        resolve({ id, delivered: false, reason: "Timed out waiting for delivery acknowledgement" });
      }, this.sendAckTimeoutMs);
      this.sends.set(id, { resolve, reject, timeout });
    });
    this.sendRaw({ type: "send", to: toSessionId, msg });
    return promise;
  }

  updatePresence(updates: PresenceUpdates): void {
    this.requireConnected();
    this.sendRaw({ type: "presence", ...updates });
  }

  async renameNode(nodeName: string): Promise<string> {
    this.requireConnected();
    const requestId = this.nextRequestId("rename");
    const promise = this.waitForRequest(requestId, (message) => {
      if (message.type === "node_renamed" && message.requestId === requestId) return message.nodeName;
      if (message.type === "error") throw new Error(message.err);
      return null;
    });
    this.sendRaw({ type: "rename_node", requestId, nodeName });
    const renamed = await promise;
    this.nodeName = renamed;
    if (this.credential) this.credential = { ...this.credential, nodeName: renamed, updatedAt: this.now() };
    return renamed;
  }

  onMessage(handler: (from: SessionInfo, message: AgentComMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onServerMessage(handler: (message: ServerMessage | AuthResponse) => void): () => void {
    this.serverMessageHandlers.add(handler);
    return () => this.serverMessageHandlers.delete(handler);
  }

  private async registerDevice(options: ConnectOptions): Promise<void> {
    if (!options.deviceToken) throw new Error("deviceToken is required for first registration");
    let privateKeyJwk = options.privateKeyJwk;
    let publicKeyJwk = options.publicKeyJwk;
    if (!publicKeyJwk && privateKeyJwk) publicKeyJwk = await publicKeyFromPrivateJwk(privateKeyJwk);
    if (!publicKeyJwk) {
      const generated = await generateDeviceKeypair();
      privateKeyJwk = generated.privateKeyJwk;
      publicKeyJwk = generated.publicKeyJwk;
    }
    if (!publicKeyJwk) throw new Error("publicKeyJwk is required for first registration");

    const requestId = this.nextRequestId("register");
    const promise = this.waitForRequest(requestId, (message) => {
      if (message.type === "register_ok" && message.requestId === requestId) return message;
      if (message.type === "register_failed" && message.requestId === requestId) throw new Error(message.reason);
      return null;
    });

    this.sendRaw({
      type: "register_device",
      requestId,
      deviceToken: options.deviceToken,
      hostname: options.hostname ?? "unknown-host",
      preferredNodeName: options.preferredNodeName,
      publicKeyJwk,
      session: options.session,
    });
    const ok = await promise;
    this.applyRegisterOk(ok);
    if (privateKeyJwk) {
      this.credential = {
        deviceId: ok.deviceId,
        nodeId: ok.nodeId,
        nodeName: ok.nodeName,
        privateKeyJwk,
        publicKeyJwk,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.reconnectOptions = { deviceId: ok.deviceId, privateKeyJwk, session: options.session };
    }
  }

  private async authenticateDevice(options: ConnectOptions): Promise<void> {
    if (!options.deviceId || !options.privateKeyJwk) throw new Error("deviceId and privateKeyJwk are required for reconnect");
    const publicKeyJwk = options.publicKeyJwk ?? await publicKeyFromPrivateJwk(options.privateKeyJwk);
    const beginRequestId = this.nextRequestId("auth-begin");
    const challengePromise = this.waitForRequest(beginRequestId, (message) => {
      if (message.type === "auth_challenge" && message.requestId === beginRequestId) return message.nonce;
      if (message.type === "auth_failed" && message.requestId === beginRequestId) throw new Error(message.reason);
      return null;
    });
    this.sendRaw({ type: "auth_begin", requestId: beginRequestId, deviceId: options.deviceId });
    const nonce = await challengePromise;

    const finishRequestId = this.nextRequestId("auth-finish");
    const finishPromise = this.waitForRequest(finishRequestId, (message) => {
      if (message.type === "register_ok" && message.requestId === finishRequestId) return message;
      if (message.type === "auth_failed" && message.requestId === finishRequestId) throw new Error(message.reason);
      return null;
    });
    this.sendRaw({
      type: "auth_finish",
      requestId: finishRequestId,
      deviceId: options.deviceId,
      signature: await signNonce(options.privateKeyJwk, nonce),
      session: options.session,
    });
    const ok = await finishPromise;
    this.applyRegisterOk(ok);
    this.credential = {
      deviceId: ok.deviceId,
      nodeId: ok.nodeId,
      nodeName: ok.nodeName,
      privateKeyJwk: options.privateKeyJwk,
      publicKeyJwk,
      updatedAt: this.now(),
    };
    this.reconnectOptions = { deviceId: ok.deviceId, privateKeyJwk: options.privateKeyJwk, session: options.session };
  }

  private applyRegisterOk(ok: Extract<AuthResponse, { type: "register_ok" }>): void {
    this.sessionId = ok.sessionId;
    this.deviceId = ok.deviceId;
    this.nodeId = ok.nodeId;
    this.nodeName = ok.nodeName;
  }

  private async openSocket(): Promise<WebSocketLike> {
    const socket = await this.webSocketFactory(this.options.serverUrl);
    if (socket.readyState === undefined || socket.readyState === OPEN) return socket;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out connecting to ${this.options.serverUrl}`)), this.connectionTimeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve(socket);
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error(`Failed to connect to ${this.options.serverUrl}`));
      }, { once: true });
    });
  }

  private attachSocket(socket: WebSocketLike): void {
    socket.addEventListener("message", (event) => this.handleRawMessage(String(event.data)));
    socket.addEventListener("close", () => this.handleClose(socket));
    socket.addEventListener("error", () => {
      // The subsequent close event owns reconnect and pending cleanup.
    });
  }

  private handleRawMessage(raw: string): void {
    let message: AuthResponse | ServerMessage;
    try {
      message = JSON.parse(raw) as AuthResponse | ServerMessage;
    } catch {
      return;
    }

    for (const handler of this.serverMessageHandlers) handler(message);

    if ("requestId" in message && typeof message.requestId === "string") {
      const pending = this.requests.get(message.requestId);
      if (pending) {
        try {
          const result = pending.accept(message);
          if (result !== null) {
            clearTimeout(pending.timeout);
            this.requests.delete(message.requestId);
            pending.resolve(result);
          }
        } catch (error) {
          clearTimeout(pending.timeout);
          this.requests.delete(message.requestId);
          pending.reject(toError(error));
        }
      }
    }

    if (message.type === "delivered" || message.type === "delivery_failed") {
      const pending = this.sends.get(message.messageId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.sends.delete(message.messageId);
        pending.resolve(message.type === "delivered"
          ? { id: message.messageId, delivered: true }
          : { id: message.messageId, delivered: false, reason: message.reason });
      }
    }

    if (message.type === "message") {
      for (const handler of this.messageHandlers) handler(message.from, message.msg);
    }
  }

  private handleClose(socket: WebSocketLike): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.sessionId = null;
    this.clearPending(new Error("Connection closed"));
    if (this.manualClose) {
      this.state = "closed";
      return;
    }
    this.state = "reconnecting";
    if (this.autoReconnect && this.reconnectOptions) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = Math.min(this.reconnectMaxDelayMs, this.reconnectBaseDelayMs * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      if (!this.reconnectOptions) return;
      void this.connect(this.reconnectOptions).catch(() => {
        if (!this.manualClose) this.scheduleReconnect();
      });
    }, delay);
  }

  private waitForRequest<T>(requestId: string, accept: PendingRequest<T>["accept"]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.requests.delete(requestId);
        reject(new Error(`Timed out waiting for ${requestId}`));
      }, this.requestTimeoutMs);
      this.requests.set(requestId, { accept: accept as PendingRequest<unknown>["accept"], resolve: resolve as (value: unknown) => void, reject, timeout });
    });
  }

  private clearPending(error: Error): void {
    for (const [requestId, pending] of this.requests) {
      clearTimeout(pending.timeout);
      this.requests.delete(requestId);
      pending.reject(error);
    }
    for (const [messageId, pending] of this.sends) {
      clearTimeout(pending.timeout);
      this.sends.delete(messageId);
      pending.reject(error);
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private requireConnected(): void {
    if (!this.isConnected()) throw new Error("RemoteComClient is not connected");
  }

  private isSocketOpen(): boolean {
    return this.socket !== null && (this.socket.readyState === undefined || this.socket.readyState === OPEN);
  }

  private sendRaw(message: IncomingMessage): void {
    if (!this.socket) throw new Error("RemoteComClient is not connected");
    this.socket.send(JSON.stringify(message));
  }

  private nextRequestId(prefix: string): string {
    return `${prefix}-${this.clientId}-${this.randomId()}`;
  }
}

function defaultWebSocketFactory(serverUrl: string): WebSocketLike {
  return new WebSocket(serverUrl) as WebSocketLike;
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
