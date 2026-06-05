import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getConfigPaths, normalizeServerUrl, type ConfigPaths } from "./config.ts";
import { isNotFound } from "./file-errors.ts";
import type { AgentComCredential } from "./types.ts";
export type { AgentComCredential } from "./types.ts";

export interface CredentialStore {
  credentials: Record<string, AgentComCredential>;
}

export async function loadCredential(serverUrl: string, paths: Partial<ConfigPaths> = {}): Promise<AgentComCredential | null> {
  const store = await loadCredentialStore(paths);
  return store.credentials[normalizeServerUrl(serverUrl)] ?? null;
}

export async function saveCredential(serverUrl: string, credential: AgentComCredential, paths: Partial<ConfigPaths> = {}): Promise<void> {
  const store = await loadCredentialStore(paths);
  const now = Date.now();
  store.credentials[normalizeServerUrl(serverUrl)] = {
    ...credential,
    createdAt: credential.createdAt ?? now,
    updatedAt: now,
  };
  await saveCredentialStore(store, paths);
}

export async function removeCredential(serverUrl: string, paths: Partial<ConfigPaths> = {}): Promise<void> {
  const store = await loadCredentialStore(paths);
  delete store.credentials[normalizeServerUrl(serverUrl)];
  await saveCredentialStore(store, paths);
}

export async function loadCredentialStore(paths: Partial<ConfigPaths> = {}): Promise<CredentialStore> {
  const resolved = { ...getConfigPaths(), ...paths };
  try {
    const parsed = JSON.parse(await readFile(resolved.credentialsPath, "utf8")) as Partial<CredentialStore>;
    return { credentials: parsed.credentials ?? {} };
  } catch (error) {
    if (isNotFound(error)) return { credentials: {} };
    throw error;
  }
}

export async function saveCredentialStore(store: CredentialStore, paths: Partial<ConfigPaths> = {}): Promise<void> {
  const resolved = { ...getConfigPaths(), ...paths };
  await mkdir(dirname(resolved.credentialsPath), { recursive: true, mode: 0o700 });
  await writeFile(resolved.credentialsPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(resolved.credentialsPath, 0o600);
}
