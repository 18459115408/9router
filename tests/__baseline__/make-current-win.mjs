// Windows-compatible wrapper for tests/__baseline__/verify-no-regression.mjs.
// The verifier derives test ids by splitting an absolute suite path on "/app/"
// (the Linux CI path). On Windows we normalize each suite path to
// /app/<workspace-relative> before handing the results to the verifier.
import { writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, relative, sep } from "node:path";

const out = resolve(import.meta.dirname, "current-win.json");
const rawOut = resolve(import.meta.dirname, "vitest-raw-win.json");
const testsDir = resolve(import.meta.dirname, "..");

try {
  execSync("npx vitest run --reporter=json --outputFile.json=__baseline__/vitest-raw-win.json", {
    cwd: testsDir,
    stdio: ["ignore", "ignore", "ignore"],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
} catch {
  // vitest exits non-zero when any test fails; the JSON report is still written.
}

const raw = JSON.parse(readFileSync(rawOut, "utf8"));

const repoRoot = resolve(import.meta.dirname, "..");
const toPosix = (p) => p.split(sep).join("/");

const results = (raw.testResults || []).map((f) => ({
  ...f,
  name: "/app/" + toPosix(relative(repoRoot, f.name)),
}));

writeFileSync(out, JSON.stringify({ ...raw, testResults: results }));
console.log(`Wrote ${results.length} suites to tests/__baseline__/current-win.json`);
