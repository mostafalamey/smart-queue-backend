import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const testFiles = process.argv.slice(2);

if (testFiles.length === 0) {
  console.error("[tests] No test files were provided.");
  process.exit(1);
}

const localJitiCli = join(
  repoRoot,
  "node_modules",
  "jiti",
  "lib",
  "jiti-cli.mjs"
);

const hasLocalJitiCli = existsSync(localJitiCli);

if (!hasLocalJitiCli) {
  console.log("[tests] Local jiti CLI not found, trying global 'jiti'.");
}

for (const testFile of testFiles) {
  console.log(`[tests] Running ${testFile} ...`);

  const result = hasLocalJitiCli
    ? spawnSync(process.execPath, [localJitiCli, testFile], {
        cwd: repoRoot,
        stdio: "inherit",
      })
    : spawnSync("jiti", [testFile], {
        cwd: repoRoot,
        stdio: "inherit",
      });

  if (result.error) {
    console.error("[tests] Failed to run test process:", result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`[tests] ✅ All ${testFiles.length} test file(s) passed.`);
