import { env } from "cloudflare:workers";
import { expect } from "vitest";
import worker from "../src/index";

export function sessionRegistration(name: string) {
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

export async function connectWebSocket(): Promise<WebSocket> {
  const response = await fetchWorker("https://agentcom.example/ws", {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).toBeDefined();
  socket!.accept();
  return socket!;
}

export async function issueToken(): Promise<string> {
  const tokenPage = await fetchWorker("https://agentcom.example/auth/device");
  expect(tokenPage.status).toBe(200);
  const html = await tokenPage.text();
  const token = html.match(/com_dev_[A-Za-z0-9_-]+/)?.[0];
  expect(token).toBeDefined();
  return token!;
}

export async function registerClient(options: { name: string; hostname: string; token?: string }) {
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

export async function signNonce(privateKey: CryptoKey, nonce: string): Promise<string> {
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(nonce));
  return base64Url(signature);
}

export function fetchWorker(input: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(input, init), env as any);
}

export function nextJson(socket: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for message")), 1000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      resolve(JSON.parse(String(event.data)));
    }, { once: true });
  });
}

export async function nextJsonOf(socket: WebSocket, type: string): Promise<any> {
  for (let i = 0; i < 10; i += 1) {
    const message = await nextJson(socket);
    if (message.type === type) return message;
  }
  throw new Error(`timed out waiting for ${type}`);
}

function base64Url(input: ArrayBuffer): string {
  const bytes = new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
