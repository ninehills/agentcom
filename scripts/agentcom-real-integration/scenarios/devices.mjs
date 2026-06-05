export async function runDeviceManagementScenario(h, { alice, context }) {
  await h.step("device management page includes hostname and ids", async () => {
    const response = await h.http("GET", "/auth/devices");
    h.assert(response.status === 200, `GET /auth/devices expected 200, got ${response.status}`);
    h.assert(response.body.includes(alice.register.deviceId), "devices page missing alice device id");
    h.assert(response.body.includes(alice.register.nodeId), "devices page missing alice node id");
    h.assert(response.body.includes(`${context.hostnamePrefix}-alice.local`), "devices page missing alice hostname");
    h.assert(response.body.includes("tester@example.com"), "devices page missing test email");
    h.assert(response.body.includes("Last seen"), "devices page missing Last seen label");
    h.assert(response.body.includes("Sessions"), "devices page missing sessions section");
    h.assert(response.body.includes(alice.register.sessionId), "devices page missing alice session id");
    h.assert(response.body.includes("alice-updated"), "devices page missing alice session name");
    h.assert(response.body.includes("CWD"), "devices page missing session cwd label");
    h.assert(response.body.includes("Model"), "devices page missing session model label");
    h.assert(response.body.includes("Runtime"), "devices page missing session runtime label");
    h.assert(response.body.includes("PID"), "devices page missing session pid label");
    h.assert(response.body.includes("Started at"), "devices page missing session startedAt label");
    h.assert(response.body.includes("Last activity"), "devices page missing session lastActivity label");
    h.assert(response.body.includes("Status"), "devices page missing session status label");
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

  await h.step("delete revoked device from management page", async () => {
    const beforeDelete = await h.http("GET", "/auth/devices");
    h.assert(beforeDelete.body.includes("Delete permanently"), "revoked devices page missing delete button");

    const response = await h.deleteDevice(alice.register.deviceId, "alice");
    h.assert(response.status === 303, `POST /auth/delete expected 303, got ${response.status}`);
    h.assert(response.headers.location === "/auth/devices", `unexpected delete location ${response.headers.location}`);

    const afterDelete = await h.http("GET", "/auth/devices");
    h.assert(!afterDelete.body.includes(alice.register.deviceId), "deleted device still appears on devices page");
  });
}

export async function cleanupDevices(h, { bob, clientDevices, piRuntimeDevices }) {
  await h.step("cleanup bob device", async () => {
    await h.revokeDevice(bob.register.deviceId, "bob cleanup");
    await h.deleteDevice(bob.register.deviceId, "bob cleanup");
  });
  await h.step("cleanup RemoteComClient devices", async () => {
    await Promise.all(clientDevices.map(async (deviceId) => {
      await h.revokeDevice(deviceId, "client cleanup");
      await h.deleteDevice(deviceId, "client cleanup");
    }));
  });
  await h.step("cleanup AgentComRuntime devices", async () => {
    await Promise.all(piRuntimeDevices.map(async (deviceId) => {
      await h.revokeDevice(deviceId, "pi runtime cleanup");
      await h.deleteDevice(deviceId, "pi runtime cleanup");
    }));
  });
}
