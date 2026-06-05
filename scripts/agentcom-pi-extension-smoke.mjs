#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const configHome = await mkdtemp(join(tmpdir(), "agentcom-pi-extension-"));
const extensionPackage = resolve("packages/pi-agentcom");

const child = spawn("pi", [
  "--mode", "rpc",
  "--no-session",
  "--no-context-files",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-builtin-tools",
  "--no-extensions",
  "-e", extensionPackage,
], {
  cwd: process.cwd(),
  env: { ...process.env, PI_OFFLINE: "1", AGENTCOM_CONFIG_HOME: configHome },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += String(chunk); });
child.stderr.on("data", (chunk) => { stderr += String(chunk); });
child.stdin.write(`${JSON.stringify({ type: "get_commands", id: "commands" })}\n`);
child.stdin.end();

const code = await new Promise((resolve) => child.on("close", resolve));
if (code !== 0) fail(`pi exited with ${code}\n${stderr}`);

const lines = stdout.trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
const response = lines.find((line) => line.id === "commands" && line.type === "response");
if (!response?.success) fail(`missing successful get_commands response\nstdout=${stdout}\nstderr=${stderr}`);
const com = response.data?.commands?.find((command) => command.name === "com" && command.source === "extension");
if (!com) fail(`agentcom /com command not registered\nstdout=${stdout}`);
if (!String(com.description).includes("agentcom")) fail(`unexpected /com description: ${com.description}`);
console.log(`PASS pi -e extension smoke: /com registered from ${com.sourceInfo?.path ?? "unknown"}`);

function fail(message) {
  console.error(`FAIL pi -e extension smoke: ${message}`);
  process.exit(1);
}
