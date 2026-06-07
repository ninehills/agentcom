import { loadCredential } from "@agentcom/client/credentials";

export async function runPiRuntimeScenario(h) {
  return h.step("AgentComRuntime joins, lists, sends, asks, replies, and panel-sends through the real Worker", async () => {
    const aliceUi = new h.RuntimeUi();
    const bobUi = new h.RuntimeUi();
    const aliceRuntime = await h.piRuntime("pi-alice");
    const bobRuntime = await h.piRuntime("pi-bob");
    const [aliceToken, bobToken] = await Promise.all([h.issueToken(), h.issueToken()]);

    const aliceJoin = await aliceRuntime.runtime.handleCommand(`join ${h.toWsUrl()} ${aliceToken}`, h.runtimeCtx("pi-alice", aliceUi));
    h.assert(aliceJoin.includes("joined"), `pi alice join failed: ${aliceJoin}`);
    const bobJoin = await bobRuntime.runtime.handleCommand(`join ${h.toWsUrl()} ${bobToken}`, h.runtimeCtx("pi-bob", bobUi));
    h.assert(bobJoin.includes("joined"), `pi bob join failed: ${bobJoin}`);
    const bobAddress = bobUi.address();

    const list = await aliceRuntime.runtime.handleCommand("list", h.runtimeCtx("pi-alice", aliceUi));
    h.assert(list.includes(bobAddress), `pi list missing bob ${bobAddress}: ${list}`);

    const sent = await aliceRuntime.runtime.handleCommand(`send ${bobAddress} hello from pi runtime`, h.runtimeCtx("pi-alice", aliceUi));
    h.assert(sent.includes("Message sent"), `pi send failed: ${sent}`);
    await h.waitFor(() => bobUi.messages.join("\n").includes("hello from pi runtime"), "bob UI did not render pi runtime message");

    const askPromise = aliceRuntime.runtime.handleCommand(`ask ${bobAddress} can runtime reply?`, h.runtimeCtx("pi-alice", aliceUi, 10_000));
    await h.waitFor(async () => {
      const pending = await bobRuntime.runtime.handleCommand("pending", h.runtimeCtx("pi-bob", bobUi));
      return pending.includes("can runtime reply?");
    }, "bob pending did not include pi runtime ask");
    const reply = await bobRuntime.runtime.handleCommand("reply yes from pi runtime", h.runtimeCtx("pi-bob", bobUi));
    h.assert(reply.includes("Reply sent"), `pi reply failed: ${reply}`);
    const askResult = await askPromise;
    h.assert(askResult.includes("yes from pi runtime"), `pi ask did not receive reply: ${askResult}`);

    aliceUi.selections.push(bobUi.addressLabel());
    aliceUi.inputs.push("panel message from pi runtime");
    const panel = await aliceRuntime.runtime.handleCommand("", h.runtimeCtx("pi-alice", aliceUi));
    h.assert(panel.includes("Message sent"), `pi panel send failed: ${panel}`);
    await h.waitFor(() => bobUi.messages.join("\n").includes("panel message from pi runtime"), "bob UI did not render panel message");

    const aliceCredential = await loadCredential(h.toWsUrl(), aliceRuntime.paths);
    const bobCredential = await loadCredential(h.toWsUrl(), bobRuntime.paths);
    aliceRuntime.runtime.shutdown();
    bobRuntime.runtime.shutdown();
    return [aliceCredential?.deviceId, bobCredential?.deviceId].filter(Boolean);
  });
}
