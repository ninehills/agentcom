import { describe, expect, it } from "vitest";
import { RemoteComClient } from "@agentcom/client/com-client";
import { resolveTarget } from "@agentcom/protocol";
import { connectWebSocket, issueToken, sessionRegistration } from "./support";

describe("RemoteComClient against agentcom Worker", () => {
  it("registers, reconnects, lists, resolves targets, sends, and renames using the Worker protocol", async () => {
    const alice = client();
    const bob = client();
    try {
      await alice.connect({
        deviceToken: await issueToken(),
        hostname: "client-alice.local",
        preferredNodeName: "client-alice",
        session: sessionRegistration("alice"),
      });
      await bob.connect({
        deviceToken: await issueToken(),
        hostname: "client-bob.local",
        preferredNodeName: "client-bob",
        session: sessionRegistration("bob"),
      });

      const sessions = await alice.listSessions();
      expect(sessions.map((session) => session.address)).toEqual(expect.arrayContaining(["alice@client-alice", "bob@client-bob"]));
      expect(resolveTarget(sessions, "bob@client-bob")).toEqual({ found: true, sessionId: bob.sessionId });

      const incoming = onceMessage(bob);
      await expect(alice.send(bob.sessionId!, { text: "hello via RemoteComClient", expectsReply: true, replyTo: "m-root", messageId: "m-client-1" })).resolves.toEqual({
        id: "m-client-1",
        delivered: true,
      });
      await expect(incoming).resolves.toMatchObject({
        from: { address: "alice@client-alice" },
        message: { id: "m-client-1", replyTo: "m-root", expectsReply: true, content: { text: "hello via RemoteComClient" } },
      });
      await expect(alice.send("s-missing", { text: "no one", messageId: "m-client-missing" })).resolves.toEqual({
        id: "m-client-missing",
        delivered: false,
        reason: "Session not found",
      });

      await expect(alice.renameNode("Client Alice Renamed")).resolves.toBe("client-alice-renamed");
      alice.updatePresence({ name: "alice-updated", status: "thinking", model: "client-test-model" });
      await expect(eventuallyList(alice, (session) => session.address === "alice-updated@client-alice-renamed" && session.status === "thinking")).resolves.toBe(true);

      const credential = alice.credential!;
      alice.disconnect();
      await alice.connect({ deviceId: credential.deviceId, privateKeyJwk: credential.privateKeyJwk, session: sessionRegistration("alice-reconnected") });
      expect(alice.deviceId).toBe(credential.deviceId);
      expect(alice.nodeId).toBe(credential.nodeId);
      expect(alice.nodeName).toBe("client-alice-renamed");
    } finally {
      alice.disconnect();
      bob.disconnect();
    }
  });
});

function client(): RemoteComClient {
  return new RemoteComClient({
    serverUrl: "wss://agentcom.example/ws",
    autoReconnect: false,
    requestTimeoutMs: 1_000,
    sendAckTimeoutMs: 1_000,
    webSocketFactory: () => connectWebSocket(),
  });
}

function onceMessage(client: RemoteComClient) {
  return new Promise<{ from: unknown; message: unknown }>((resolve) => {
    const off = client.onMessage((from, message) => {
      off();
      resolve({ from, message });
    });
  });
}

async function eventuallyList(client: RemoteComClient, predicate: (session: any) => boolean): Promise<boolean> {
  for (let i = 0; i < 5; i += 1) {
    const sessions = await client.listSessions();
    if (sessions.some(predicate)) return true;
  }
  return false;
}
