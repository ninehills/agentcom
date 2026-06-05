import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isNotFound } from "./file-errors.ts";

export interface AgentComConfig {
  serverUrl?: string;
  authUrl?: string;
  autoJoin?: boolean;
  confirmSend?: boolean;
  replyHint?: boolean;
}

export interface ConfigPaths {
  configHome: string;
  configPath: string;
  credentialsPath: string;
}

export function getConfigPaths(env: NodeJS.ProcessEnv = process.env): ConfigPaths {
  const configHome = env.AGENTCOM_CONFIG_HOME?.trim()
    || (env.XDG_CONFIG_HOME?.trim() ? join(env.XDG_CONFIG_HOME, "agentcom") : join(homedir(), ".config", "agentcom"));
  return {
    configHome,
    configPath: join(configHome, "config.json"),
    credentialsPath: join(configHome, "credentials.json"),
  };
}

export async function loadConfig(paths: Partial<ConfigPaths> = {}): Promise<AgentComConfig> {
  const resolved = { ...getConfigPaths(), ...paths };
  try {
    return JSON.parse(await readFile(resolved.configPath, "utf8")) as AgentComConfig;
  } catch (error) {
    if (isNotFound(error)) return {};
    throw error;
  }
}

export async function saveConfig(config: AgentComConfig, paths: Partial<ConfigPaths> = {}): Promise<void> {
  const resolved = { ...getConfigPaths(), ...paths };
  await mkdir(resolved.configHome, { recursive: true, mode: 0o700 });
  await writeFile(resolved.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
}

export function normalizeServerUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/ws";
  return url.toString().replace(/\/$/, "");
}

export function authBaseUrlFromServerUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
