import { mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getConfigPaths, loadConfig, normalizeServerUrl, saveConfig } from "../src/config.ts";
import { loadCredential, saveCredential } from "../src/credentials.ts";
import { generateDeviceKeypair, signNonce } from "../src/crypto.ts";

describe("agentcom shared config and credentials", () => {
  it("stores credentials by normalized serverUrl and enforces 0600 permissions", async () => {
    const configHome = await tempConfigHome();
    const paths = { ...getConfigPaths({ AGENTCOM_CONFIG_HOME: configHome }), configHome };
    const keypair = await generateDeviceKeypair();

    await saveCredential("wss://agentcom.example/ws/", {
      deviceId: "d-1",
      nodeId: "n-1",
      nodeName: "macbook",
      privateKeyJwk: keypair.privateKeyJwk,
      publicKeyJwk: keypair.publicKeyJwk,
    }, paths);

    await expect(loadCredential("wss://agentcom.example/ws", paths)).resolves.toMatchObject({
      deviceId: "d-1",
      nodeId: "n-1",
      nodeName: "macbook",
    });
    expect((await stat(paths.credentialsPath)).mode & 0o777).toBe(0o600);
  });

  it("reads and writes shared config and signs nonces with P-256 JWKs", async () => {
    const configHome = await tempConfigHome();
    const paths = { ...getConfigPaths({ AGENTCOM_CONFIG_HOME: configHome }), configHome };
    await saveConfig({ serverUrl: "wss://agentcom.example/ws", autoJoin: true }, paths);
    await expect(loadConfig(paths)).resolves.toEqual({ serverUrl: "wss://agentcom.example/ws", autoJoin: true });

    const keypair = await generateDeviceKeypair();
    await expect(signNonce(keypair.privateKeyJwk, "nonce-test")).resolves.toMatch(/^[A-Za-z0-9_-]+$/);
    expect(normalizeServerUrl("wss://agentcom.example/ws/")).toBe("wss://agentcom.example/ws");
  });
});

async function tempConfigHome(): Promise<string> {
  const dir = join(tmpdir(), `agentcom-client-test-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}
