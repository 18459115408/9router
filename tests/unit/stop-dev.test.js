import { describe, it, expect } from "vitest";
import {
  isProductionProcess,
  isDevProcess,
  stopDevServer,
} from "../../scripts/stop-dev.mjs";

// The two real trees this box had running when the script was written:
//
//   dev (mine, on :20127)          gateway (the operator's, on :20128)
//   25244 npm-cli.js run dev       21088 cmd.exe /c next dev --port 20127 --port 20128
//     └ 20504 cmd /c next dev       └ 20128 node next dev --port 20127 --port 20128
//        └ 22892 next dev              └ 8792 start-server.js   ← serves :20128
//           ├ 24192 start-server.js     (listener)
//           └ 2952 .next/dev chunk
//
// The gateway's command line is a dev command line — that is the whole
// difficulty, and why port ownership has to decide, not the cmdline.
const MINE = [
  { pid: 25244, ppid: 1, cmdline: 'C:\\nvm4w\\nodejs\\node.exe npm-cli.js run dev --' },
  { pid: 20504, ppid: 25244, cmdline: 'C:\\Windows\\system32\\cmd.exe /d /s /c next dev --port 20127' },
  { pid: 22892, ppid: 20504, cmdline: '"node"  "next\\dist\\bin\\next" dev --port 20127' },
  { pid: 24192, ppid: 22892, cmdline: 'node.exe next\\dist\\server\\lib\\start-server.js' },
  { pid: 2952, ppid: 22892, cmdline: 'node G:\\code\\9router\\.next\\dev\\build\\chunks\\pool_entry.js' },
];
const GATEWAY = [
  { pid: 21088, ppid: 1, cmdline: 'C:\\Windows\\system32\\cmd.exe /d /s /c next dev --port 20127 --port 20128' },
  { pid: 20128, ppid: 21088, cmdline: '"node"  "next\\dist\\bin\\next" dev --port 20127 --port 20128' },
  { pid: 8792, ppid: 20128, cmdline: 'node.exe next\\dist\\server\\lib\\start-server.js' },
];

const inj = (extra = {}) => ({
  processes: [...MINE, ...GATEWAY],
  listeners: [24192],
  listenersByPort: { 20128: [8792] },
  ...extra,
});

describe("stop-dev process classification", () => {
  it("spares only unambiguous production shapes", () => {
    expect(isProductionProcess('node custom-server.js --port 20128')).toBe(true);
    expect(isProductionProcess('node G:\\code\\9router\\.next\\standalone\\custom-server.js')).toBe(true);
    expect(isProductionProcess('"node"  "next\\dist\\bin\\next" start --port 20128')).toBe(true);
  });

  it("does not mistake a dev-spawned start-server for production", () => {
    // Next 16's dev spawns start-server.js as the port holder; treating it as
    // production made the script refuse to stop its own dev server.
    expect(isProductionProcess('node.exe next\\dist\\server\\lib\\start-server.js')).toBe(false);
  });

  it("recognizes the dev shapes without claiming production", () => {
    expect(isDevProcess('"node"  "next\\dist\\bin\\next" dev --port 20127', 20127)).toBe(true);
    expect(isDevProcess('npm-cli.js run dev --', 20127)).toBe(true);
    expect(isDevProcess('node G:\\code\\9router\\.next\\dev\\build\\chunks\\pool.js', 20127)).toBe(true);
    expect(isDevProcess('node custom-server.js --port 20128', 20127)).toBe(false);
  });

  it("does not claim a dev run bound to a different port", () => {
    expect(isDevProcess('"next" dev --port 20129', 20127)).toBe(false);
    expect(isDevProcess('"next" dev --port 20129', 20129)).toBe(true);
  });
});

describe("stopDevServer", () => {
  it("stops the dev tree and leaves the gateway on the other port alone", () => {
    const killed = stopDevServer({ dryRun: true }, inj()).targets.map((t) => t.pid).sort((a, b) => a - b);
    expect(killed).toEqual([2952, 20504, 22892, 24192, 25244]);
    // Nothing from the gateway's tree — parent, launcher, or listener — and
    // nothing it wraps.
    expect(killed).not.toContain(20128);
    expect(killed).not.toContain(8792);
    expect(killed).not.toContain(21088);
  });

  it("refuses a production shape on the target port without --force", () => {
    // Someone running the production build on the dev port would otherwise be
    // indistinguishable from a dev run.
    const prod = [{ pid: 500, ppid: 1, cmdline: 'node custom-server.js --port 20127' }];
    const report = stopDevServer({ dryRun: true }, { processes: prod, listeners: [500] });
    expect(report.targets).toEqual([]);
    expect(report.spared).toHaveLength(1);
    expect(report.spared[0]).toMatchObject({ pid: 500, reason: "looks like a production instance" });

    const forced = stopDevServer({ dryRun: true, force: true }, { processes: prod, listeners: [500] });
    expect(forced.targets.map((t) => t.pid)).toEqual([500]);
  });

  it("sweeps orphaned dev processes after the background shell is killed", () => {
    const killed = stopDevServer({ dryRun: true }, inj({
      listeners: [], // the listener died with the harness; wrappers remain
    })).targets.map((t) => t.pid).sort((a, b) => a - b);
    expect(killed).toEqual([2952, 20504, 22892, 25244]);
    expect(killed).not.toContain(8792);
    expect(killed).not.toContain(20128);
  });

  it("never lets the sweep reach across ports at the gateway", () => {
    // Even with no listener at all, the gateway's dev command line must not
    // make it a sweep target: it owns :20128.
    const report = stopDevServer({ dryRun: true, port: 20127 }, {
      processes: GATEWAY,
      listeners: [],
      listenersByPort: { 20128: [8792] },
    });
    expect(report.targets).toEqual([]);
  });
});
