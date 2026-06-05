export async function runDeviceManagementScenario(h, { alice, context }) {
  await h.step("device management page includes hostname and ids", async () => {
    const response = await h.http("GET", "/auth/devices");
    h.assert(response.status === 200, `GET /auth/devices expected 200, got ${response.status}`);
    h.assert(response.body.includes(alice.register.deviceId), "devices page missing alice device id");
    h.assert(response.body.includes(alice.register.nodeId), "devices page missing alice node id");
    h.assert(response.body.includes(`${context.hostnamePrefix}-alice.local`), "devices page missing alice hostname");
    h.assert(response.body.includes("tester@example.com"), "devices page missing test email");
    h.assert(response.body.includes("Last seen"), "devices page missing Last seen label");
  });
}

export async function revokeAndVerifyDevice(h, alice) {
  await h.step("revoke device and reject future reconnect", async () => {
    const response = await h.revokeDevice(alice.register.deviceId, "alice");
    h.assert(response.status === 303, `POST /auth/revoke expected 303, got ${response.status}`);
    h.assert(response.headers.location === "/auth/devices", `unexpected revoke location ${response.headers.location}`);

    const reconnect = await h.connectWebSocket("revoked-reconnect");
    reconnect.send(JSON.stringify({ type: "auth_begin", requestId: "req-revoked", deviceId: alice.register.deviceId }));
    const failed = await h.nextJsonOf(reconnect, "auth_failed");
    h.assert(failed.reason === "Device not found or revoked", `unexpected revoked failure: ${failed.reason}`);
    reconnect.close();
  });
}

export async function cleanupDevices(h, { bob, clientDevices, piRuntimeDevices }) {
  await h.step("cleanup bob device", () => h.revokeDevice(bob.register.deviceId, "bob cleanup"));
  await h.step("cleanup RemoteComClient devices", () => Promise.all(clientDevices.map((deviceId) => h.revokeDevice(deviceId, "client cleanup"))));
  await h.step("cleanup AgentComRuntime devices", () => Promise.all(piRuntimeDevices.map((deviceId) => h.revokeDevice(deviceId, "pi runtime cleanup"))));
}
