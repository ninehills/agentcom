export async function runProtocolScenario(h, context) {
  await h.step("health check", async () => {
    const response = await h.http("GET", "/");
    h.assert(response.status === 200, `GET / expected 200, got ${response.status}`);
    h.assert(response.body.includes("agentcom ok"), "GET / body should contain agentcom ok");
  });

  await h.step("plain /ws requires websocket upgrade", async () => {
    const response = await h.http("GET", "/ws");
    h.assert(response.status === 426, `GET /ws expected 426, got ${response.status}`);
    h.assert(response.body.includes("Expected Upgrade: websocket"), "GET /ws should explain expected websocket upgrade");
  });

  const alice = await h.step("register alice with browser-issued token", () => h.registerClient({
    name: "alice",
    hostname: `${context.hostnamePrefix}-alice.local`,
    preferredNodeName: `${context.hostnamePrefix}-alice`,
  }));

  await h.step("reject reused registration token", async () => {
    const socket = await h.connectWebSocket("reuse-token");
    const keypair = await h.generateKeypair();
    socket.send(JSON.stringify({
      type: "register_device",
      requestId: "req-reuse-token",
      deviceToken: alice.token,
      hostname: `${context.hostnamePrefix}-reuse.local`,
      publicKeyJwk: keypair.publicKeyJwk,
      session: h.sessionRegistration("reuse"),
    }));
    const failed = await h.nextJsonOf(socket, "register_failed");
    h.assert(failed.reason === "Invalid or expired device token", `unexpected reuse-token failure reason: ${failed.reason}`);
    socket.close();
  });

  const bob = await h.step("register bob with a second token", () => h.registerClient({
    name: "bob",
    hostname: `${context.hostnamePrefix}-bob.local`,
    preferredNodeName: `${context.hostnamePrefix}-bob`,
  }));

  await h.step("list online sessions", async () => {
    alice.socket.send(JSON.stringify({ type: "list", requestId: "req-list" }));
    const list = await h.nextJsonOf(alice.socket, "sessions");
    const addresses = list.sessions.map((session) => session.address);
    h.assert(addresses.includes(`alice@${alice.register.nodeName}`), `sessions missing alice address; got ${addresses.join(", ")}`);
    h.assert(addresses.includes(`bob@${bob.register.nodeName}`), `sessions missing bob address; got ${addresses.join(", ")}`);
  });

  await h.step("deliver message by session id", async () => {
    const msg = { id: `m-${h.runId}`, timestamp: Date.now(), content: { text: "hello from real integration test" } };
    alice.socket.send(JSON.stringify({ type: "send", to: bob.register.sessionId, msg }));
    const received = await h.nextJsonOf(bob.socket, "message");
    h.assert(received.from.address === `alice@${alice.register.nodeName}`, `unexpected sender ${received.from.address}`);
    h.assert(received.msg.content.text === msg.content.text, "delivered message text mismatch");
    const delivered = await h.nextJsonOf(alice.socket, "delivered");
    h.assert(delivered.messageId === msg.id, `unexpected delivered ack ${JSON.stringify(delivered)}`);
  });

  await h.step("broadcast presence update", async () => {
    alice.socket.send(JSON.stringify({ type: "presence", name: "alice-updated", status: "thinking", model: "real-test-model" }));
    const update = await h.nextJsonOf(bob.socket, "presence_update");
    h.assert(update.session.name === "alice-updated", `unexpected presence name ${update.session.name}`);
    h.assert(update.session.status === "thinking", `unexpected presence status ${update.session.status}`);
    h.assert(update.session.model === "real-test-model", `unexpected presence model ${update.session.model}`);
  });

  const renamedNodeName = await h.step("rename node and verify session list reflects it", async () => {
    const requested = `${context.hostnamePrefix}-renamed`;
    alice.socket.send(JSON.stringify({ type: "rename_node", requestId: "req-rename", nodeName: requested }));
    const renamed = await h.nextJsonOf(alice.socket, "node_renamed");
    h.assert(renamed.nodeId === alice.register.nodeId, `rename node id mismatch ${renamed.nodeId}`);
    h.assert(renamed.nodeName === requested, `unexpected renamed nodeName ${renamed.nodeName}`);
    alice.socket.send(JSON.stringify({ type: "list", requestId: "req-list-after-rename" }));
    const list = await h.nextJsonOf(alice.socket, "sessions");
    h.assert(list.sessions.some((session) => session.id === alice.register.sessionId && session.address === `alice-updated@${requested}`), "renamed node was not reflected in session list");
    return renamed.nodeName;
  });

  await h.step("reconnect registered device with signed challenge", async () => {
    const reconnect = await h.connectWebSocket("alice-reconnect");
    reconnect.send(JSON.stringify({ type: "auth_begin", requestId: "req-auth-begin", deviceId: alice.register.deviceId }));
    const challenge = await h.nextJsonOf(reconnect, "auth_challenge");
    h.assert(typeof challenge.nonce === "string" && challenge.nonce.length > 10, "auth challenge nonce missing");
    reconnect.send(JSON.stringify({
      type: "auth_finish",
      requestId: "req-auth-finish",
      deviceId: alice.register.deviceId,
      signature: await h.signNonce(alice.privateKey, challenge.nonce),
      session: h.sessionRegistration("alice-reconnected"),
    }));
    const ok = await h.nextJsonOf(reconnect, "register_ok");
    h.assert(ok.deviceId === alice.register.deviceId, `reconnect device mismatch ${ok.deviceId}`);
    h.assert(ok.nodeId === alice.register.nodeId, `reconnect node mismatch ${ok.nodeId}`);
    h.assert(ok.nodeName === renamedNodeName, `reconnect nodeName mismatch ${ok.nodeName}`);
    reconnect.close();
  });

  await h.step("reject invalid reconnect signature", async () => {
    const reconnect = await h.connectWebSocket("bad-signature");
    const otherKeypair = await h.generateKeypair();
    reconnect.send(JSON.stringify({ type: "auth_begin", requestId: "req-bad-begin", deviceId: bob.register.deviceId }));
    const challenge = await h.nextJsonOf(reconnect, "auth_challenge");
    reconnect.send(JSON.stringify({
      type: "auth_finish",
      requestId: "req-bad-finish",
      deviceId: bob.register.deviceId,
      signature: await h.signNonce(otherKeypair.privateKey, challenge.nonce),
      session: h.sessionRegistration("bad-signature"),
    }));
    const failed = await h.nextJsonOf(reconnect, "auth_failed");
    h.assert(failed.reason === "Invalid signature", `unexpected bad signature failure: ${failed.reason}`);
    reconnect.close();
  });

  return { alice, bob, renamedNodeName };
}
