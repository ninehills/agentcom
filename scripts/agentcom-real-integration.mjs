#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHarness, errorToLog, normalizeBaseUrl } from "./agentcom-real-integration/harness.mjs";
import { runProtocolScenario } from "./agentcom-real-integration/scenarios/protocol.mjs";
import { runRemoteClientScenario } from "./agentcom-real-integration/scenarios/remote-client.mjs";
import { runPiRuntimeScenario } from "./agentcom-real-integration/scenarios/pi-runtime.mjs";
import { cleanupDevices, revokeAndVerifyDevice, runDeviceManagementScenario } from "./agentcom-real-integration/scenarios/devices.mjs";

const DEFAULT_BASE_URL = "https://agentcom-test.swulling.workers.dev";
const baseUrl = normalizeBaseUrl(process.env.AGENTCOM_BASE_URL ?? process.argv[2] ?? DEFAULT_BASE_URL);
const runId = process.env.AGENTCOM_TEST_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
const logPath = resolve(process.env.AGENTCOM_TEST_LOG ?? `logs/agentcom-real-integration-${runId}.jsonl`);

await mkdir(dirname(logPath), { recursive: true });
const h = createHarness({ baseUrl, runId, logPath });

try {
  await h.log("run.start", { baseUrl, runId, node: process.version });
  const context = { hostnamePrefix: `agentcom-it-${runId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 32)}` };

  const { alice, bob } = await runProtocolScenario(h, context);
  const clientDevices = await runRemoteClientScenario(h, context);
  const piRuntimeDevices = await runPiRuntimeScenario(h);

  await runDeviceManagementScenario(h, { alice, context });
  await revokeAndVerifyDevice(h, alice);
  await cleanupDevices(h, { bob, clientDevices, piRuntimeDevices });

  await h.log("run.pass", { logPath });
  console.log(`PASS real integration test against ${baseUrl}`);
  console.log(`Log: ${logPath}`);
} catch (error) {
  await h.log("run.fail", { error: errorToLog(error), logPath });
  console.error(`FAIL real integration test against ${baseUrl}`);
  console.error(error?.stack ?? error);
  console.error(`Log: ${logPath}`);
  process.exitCode = 1;
} finally {
  h.closeSockets();
  await h.writeLog();
}
