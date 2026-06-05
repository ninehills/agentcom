#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const packages = [
  "@agentcom/protocol",
  "@agentcom/client",
  "@agentcom/pi-agentcom",
];

const extraArgs = process.argv.slice(2);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

for (const workspace of packages) {
  console.log(`\n>>> npm publish --workspace ${workspace}`);

  const result = spawnSync(
    npm,
    ["publish", "--workspace", workspace, "--access", "public", ...extraArgs],
    { stdio: "inherit" },
  );

  if (result.signal) {
    console.error(`Publishing ${workspace} stopped by signal ${result.signal}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
