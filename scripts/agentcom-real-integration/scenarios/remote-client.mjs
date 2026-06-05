import { resolveTarget } from "@agentcom/protocol";

export async function runRemoteClientScenario(h, context) {
  return h.step("RemoteComClient registers, reconnects, resolves, and sends through the real Worker", async () => {
    const carol = h.remoteClient("carol");
    const dave = h.remoteClient("dave");
    try {
      const [carolToken, daveToken] = await Promise.all([h.issueToken(), h.issueToken()]);
      await Promise.all([
        carol.connect({ deviceToken: carolToken, hostname: `${context.hostnamePrefix}-client-carol.local`, preferredNodeName: `${context.hostnamePrefix}-client-carol`, session: h.sessionRegistration("client-carol") }),
        dave.connect({ deviceToken: daveToken, hostname: `${context.hostnamePrefix}-client-dave.local`, preferredNodeName: `${context.hostnamePrefix}-client-dave`, session: h.sessionRegistration("client-dave") }),
      ]);

      const sessions = await carol.listSessions();
      const resolved = resolveTarget(sessions, `client-dave@${dave.nodeName}`);
      h.assert(resolved.found, resolved.reason ?? "RemoteComClient could not resolve dave");
      h.assert(resolved.sessionId === dave.sessionId, `RemoteComClient resolved ${resolved.sessionId}, expected ${dave.sessionId}`);

      const incoming = h.onceRemoteMessage(dave);
      const sent = await carol.send(resolved.sessionId, {
        text: "hello from RemoteComClient real integration",
        replyTo: `root-${h.runId}`,
        expectsReply: true,
        messageId: `m-client-${h.runId}`,
      });
      h.assert(sent.delivered, `RemoteComClient send failed: ${sent.reason}`);
      const received = await incoming;
      h.assert(received.from.address === `client-carol@${carol.nodeName}`, `RemoteComClient sender mismatch ${received.from.address}`);
      h.assert(received.message.replyTo === `root-${h.runId}`, "RemoteComClient replyTo missing");
      h.assert(received.message.expectsReply === true, "RemoteComClient expectsReply missing");
      h.assert(received.message.content.text === "hello from RemoteComClient real integration", "RemoteComClient message text mismatch");

      const credential = carol.credential;
      h.assert(credential?.deviceId && credential.privateKeyJwk, "RemoteComClient did not expose generated credential");
      carol.disconnect();
      await carol.connect({ deviceId: credential.deviceId, privateKeyJwk: credential.privateKeyJwk, session: h.sessionRegistration("client-carol-reconnected") });
      h.assert(carol.deviceId === credential.deviceId, "RemoteComClient reconnect device mismatch");
      h.assert(carol.nodeId === credential.nodeId, "RemoteComClient reconnect node mismatch");
      return [carol.credential?.deviceId, dave.credential?.deviceId].filter(Boolean);
    } finally {
      carol.disconnect();
      dave.disconnect();
    }
  });
}
