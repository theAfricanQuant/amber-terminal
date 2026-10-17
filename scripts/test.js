#!/usr/bin/env node
// Runs every test/*.test.js except the live-network suite in isolated Node processes.
// Test files replace fetch and process environment variables, so one shared test process
// can make offline results depend on file scheduling. Test-owned mode variables are
// cleared from child environments; tests opt into QT_OFFLINE explicitly when needed.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = readdirSync(new URL("../test/", import.meta.url))
  .filter((f) => f.endsWith(".test.js") && f !== "live.test.js")
  .sort()
  .map((f) => `test/${f}`);
const testEnv = { ...process.env };
for (const name of [
  "QT_OFFLINE",
  "PUBLIC_DEMO",
  "PUBLIC_DEMO_HOST",
  "PUBLIC_HOST",
  "QT_DATA_DIR",
  "PTQ_HOME",
  "PTQ_URL",
])
  delete testEnv[name];
let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ["--test", file], {
    stdio: "inherit",
    env: testEnv,
  });
  if (r.error || r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
