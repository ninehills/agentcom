import { describe, expect, it } from "vitest";
import { connectWebSocket, fetchWorker, issueToken, nextJson, nextJsonOf, registerClient, sessionRegistration, signNonce } from "./support";

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

  it("shows, revokes, and deletes the current user's revoked devices", async () => {
    const client = await registerClient({ name: "device", hostname: "device-box" });

    const devices = await fetchWorker("https://agentcom.example/auth/devices");
    expect(devices.status).toBe(200);
    const html = await devices.text();
    expect(html).toContain(client.message.deviceId);
    expect(html).toContain(client.message.nodeId);
    expect(html).toContain("device-box");
    expect(html).toContain("tester@example.com");
    expect(html).toContain("Last seen");
    expect(html).toContain("Revoke");

    const activeDelete = await fetchWorker("https://agentcom.example/auth/delete", {
      method: "POST",
      body: new URLSearchParams({ deviceId: client.message.deviceId }),
      redirect: "manual",
    });
    expect(activeDelete.status).toBe(409);

    const revoked = await fetchWorker("https://agentcom.example/auth/revoke", {
      method: "POST",
      body: new URLSearchParams({ deviceId: client.message.deviceId }),
      redirect: "manual",
    });
    expect(revoked.status).toBe(303);

    const revokedDevices = await fetchWorker("https://agentcom.example/auth/devices");
    const revokedHtml = await revokedDevices.text();
    expect(revokedHtml).toContain(client.message.deviceId);
    expect(revokedHtml).toContain("Delete permanently");

    const socket = await connectWebSocket();
    socket.send(JSON.stringify({ type: "auth_begin", requestId: "req-revoked", deviceId: client.message.deviceId }));
    expect(await nextJson(socket)).toMatchObject({ type: "auth_failed", reason: "Device not found or revoked" });

    const deleted = await fetchWorker("https://agentcom.example/auth/delete", {
      method: "POST",
      body: new URLSearchParams({ deviceId: client.message.deviceId }),
      redirect: "manual",
    });
    expect(deleted.status).toBe(303);

    const afterDelete = await fetchWorker("https://agentcom.example/auth/devices");
    expect(await afterDelete.text()).not.toContain(client.message.deviceId);
  });
});
