// Stop the dev server cleanly — and only the dev server.
//
// Why this exists: stopping a backgrounded `npm run dev` killed the npm
// wrapper and left `next dev` plus its children running, and the follow-up
// cleanup matched node.exe *by binary name* and took the production gateway
// on :20128 down with it. Both failure modes come from the same root: no
// tool that knows which processes belong to a dev run.
//
// The rules this script follows, in order of importance:
//   1. It never matches on the executable name. Command lines are how a
//      process is judged, and even then only as a hint.
//   2. Port ownership is the binding rule. Everything serving — or wrapping,
//      or spawned by a listener on — any port other than the one being
//      stopped is untouchable. That is what keeps a second gateway alive on
//      this box: it runs `next dev` too, on :20128, so its command line looks
//      exactly like a dev run's and only the port tells them apart.
//   3. The listener on the dev port (default 20127) is stopped together with
//      its descendants and the wrappers above it (npm, cmd, next dev).
//   4. Orphans of a killed background task are swept by dev command-line
//      markers, still under rules 2 and 3.
//   5. An unambiguous production shape on the target port (custom-server.js,
//      a standalone build, `next start`) is refused without --force.
//
// Usage:
//   node scripts/stop-dev.mjs              # stop the dev server on :20127
//   node scripts/stop-dev.mjs --dry-run    # report what it would do, kill nothing
//   node scripts/stop-dev.mjs --port 20127 # stop a different dev port
//   node scripts/stop-dev.mjs --force      # also stop a production shape on the target port

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DEV_PORT_DEFAULT = 20127;

// Command lines that mark an unambiguous production run: the fork's
// custom-server wrapper and the standalone tree only exist in a production
// build, and `next start` is the production supervisor. Note what is NOT
// here: `start-server.js` is spawned by dev too (it is the process that ends
// up holding the port), so treating it as production would make the script
// refuse to stop its own dev server.
const PRODUCTION_MARKERS = [
  /custom-server\.js/i,
  /[\\/]\.next[\\/]standalone[\\/]/i,
  /\\next"?\s+start(\s|$)/i,
  /(^|\s)next"?\s+start(\s|$)/i,
];

// Command lines that mark a process as part of a dev run. This alone is NOT
// permission to kill: a production gateway started in dev mode (this box runs
// one on :20128) looks identical. The port-ownership check is what actually
// keeps them apart — see foreignTrees().
const DEV_MARKERS = [
  /(^|\s|"|\\|\/)next"?\s+dev(\s|$)/i,
  /npm-cli\.js"?\s+run\s+dev\b/is,
  /npx-cli\.js"?\s+(run\s+)?dev\b/is,
  /[\\/]\.next[\\/]dev[\\/]/i,
];

/**
 * Is this command line a production instance that must not be stopped?
 * @param {string} cmdline
 * @returns {boolean}
 */
export function isProductionProcess(cmdline) {
  const line = String(cmdline || "");
  return PRODUCTION_MARKERS.some((re) => re.test(line));
}

/**
 * Is this command line part of a dev run?
 * @param {string} cmdline
 * @param {number} [port] when given, a `--port <n>` flag on the same command
 *   line makes the match unambiguous
 * @returns {boolean}
 */
export function isDevProcess(cmdline, port) {
  const line = String(cmdline || "");
  if (isProductionProcess(line)) return false;
  if (!DEV_MARKERS.some((re) => re.test(line))) return false;
  if (port && /--port[= ]\d+/.test(line) && !new RegExp(`--port[= ]${port}\\b`).test(line)) {
    return false; // a dev run on a different port is not ours
  }
  return true;
}

function parseArgs(argv) {
  const args = { dryRun: false, force: false, port: DEV_PORT_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a.startsWith("--port=")) args.port = Number(a.slice(7));
    else if (a === "-h" || a === "--help") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const USAGE = `Usage: node scripts/stop-dev.mjs [--dry-run] [--force] [--port N]
  --dry-run  report what would be stopped, stop nothing
  --force    allow stopping a port that looks like a production instance
  --port N   dev port to stop (default ${DEV_PORT_DEFAULT})`;

const IS_WINDOWS = process.platform === "win32";

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Every node-ish process on the box as { pid, ppid, cmdline }. */
function listProcesses() {
  if (!IS_WINDOWS) {
    try {
      const out = run("ps", ["-eo", "pid,ppid,args"]);
      return out.split("\n").slice(1).map((line) => {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmdline: m[3] } : null;
      }).filter(Boolean);
    } catch {
      return [];
    }
  }
  try {
    const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -ne $null } | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)" }`;
    const out = run("powershell", ["-NoProfile", "-Command", ps]);
    return out.split("\n").map((line) => {
      const i = line.indexOf("|");
      const j = line.indexOf("|", i + 1);
      if (i < 0 || j < 0) return null;
      return { pid: Number(line.slice(0, i)), ppid: Number(line.slice(i + 1, j)), cmdline: line.slice(j + 1).trim() };
    }).filter((p) => p && Number.isFinite(p.pid));
  } catch {
    return [];
  }
}

/** PIDs listening on the port. */
function listenersOn(port) {
  const pids = new Set();
  const needle = `:${port}`;
  try {
    const out = IS_WINDOWS ? run("netstat", ["-ano"]) : run("ss", ["-ltnp"]);
    for (const line of out.split("\n")) {
      if (!line.includes(needle)) continue;
      if (!/LISTENING|LISTEN\b/.test(line)) continue;
      const m = IS_WINDOWS ? line.trim().split(/\s+/).pop() : line.match(/pid=(\d+)/);
      const pid = IS_WINDOWS ? Number(m) : Number(m?.[1]);
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }
  } catch {
    // No netstat/ss (or no permission): the command-line sweep below still runs.
  }
  return [...pids];
}

/** The pid plus every descendant, from the process list. */
function withDescendants(pid, processes) {
  const out = new Set([pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of processes) {
      if (out.has(p.ppid) && !out.has(p.pid)) {
        out.add(p.pid);
        grew = true;
      }
    }
  }
  return [...out];
}

function killTree(pids) {
  for (const pid of pids) {
    if (IS_WINDOWS) {
      try {
        run("taskkill", ["/PID", String(pid), "/T", "/F"]);
      } catch {
        // Already gone, or taskkill missing: the verification step reports the truth.
      }
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
}

/**
 * Decide what to stop and stop it. Exported so a test can drive it against
 * synthetic process lists.
 *
 * The rule that keeps this safe on a box that runs a second gateway: port
 * ownership outranks everything. Every process that serves, wraps, or was
 * spawned by a listener on any port OTHER than the one being stopped is
 * forbidden, whatever its command line says. This box's own gateway listens
 * on :20128 and its command line is `next dev` — indistinguishable from a dev
 * run by inspection alone — so that tree is off-limits by port, not by shape.
 *
 * @param {{ dryRun?: boolean, force?: boolean, port?: number }} options
 * @param {{ processes?: Array<{pid:number,ppid:number,cmdline:string}>, listeners?: number[], listenersByPort?: Record<number, number[]> }} [injected]
 */
export function stopDevServer(options = {}, injected = {}) {
  const { dryRun = false, force = false, port = DEV_PORT_DEFAULT } = options;
  const processes = injected.processes || listProcesses();
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const targets = new Set();
  const spared = [];
  const forbidden = new Set();

  // Ports other servers on this machine claim in their command lines. Any
  // listener on one of those ports owns a tree that is not ours to stop.
  const otherPorts = new Set();
  for (const p of processes) {
    for (const m of String(p.cmdline).matchAll(/--port[= ](\d+)/g)) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && n !== port) otherPorts.add(n);
    }
  }
  for (const other of otherPorts) {
    const listeners = injected.listenersByPort?.[other] ?? listenersOn(other);
    for (const pid of listeners) {
      for (const q of withDescendants(pid, processes)) forbidden.add(q);
      // Wrappers above it belong to that server too.
      let cur = byPid.get(pid);
      while (cur?.ppid && !forbidden.has(cur.ppid)) {
        forbidden.add(cur.ppid);
        cur = byPid.get(cur.ppid);
      }
    }
  }

  // 1. The listener on the port being stopped, its descendants, and the npm /
  //    cmd / next-dev wrappers above it that launched it.
  const listeners = injected.listeners ?? listenersOn(port);
  for (const pid of listeners) {
    const proc = byPid.get(pid);
    const cmdline = proc?.cmdline || "";
    if (isProductionProcess(cmdline) && !force) {
      spared.push({ pid, cmdline, reason: "looks like a production instance" });
      continue;
    }
    for (const q of withDescendants(pid, processes)) {
      if (!forbidden.has(q)) targets.add(q);
    }
    let cur = proc;
    while (cur?.ppid && !forbidden.has(cur.ppid)) {
      const parent = byPid.get(cur.ppid);
      if (!parent) break;
      // Only climb through wrappers that provably launched this run; an
      // unrelated ancestor (explorer, a service host) ends the walk.
      if (!isDevProcess(parent.cmdline, port)) break;
      targets.add(parent.pid);
      cur = parent;
    }
  }

  // 2. Orphans: dev-run processes still alive with no listener to lead to
  //    them (the case where the background task's shell was killed first).
  for (const p of processes) {
    if (targets.has(p.pid) || forbidden.has(p.pid)) continue;
    if (isProductionProcess(p.cmdline)) continue;
    if (isDevProcess(p.cmdline, port)) targets.add(p.pid);
  }

  const report = {
    port,
    dryRun,
    targets: [...targets].map((pid) => ({ pid, cmdline: byPid.get(pid)?.cmdline || "" })),
    spared,
  };
  if (!dryRun && targets.size) killTree([...targets]);
  return report;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[stop-dev] ${err.message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const report = stopDevServer(args);
  if (!report.targets.length && !report.spared.length) {
    console.log(`[stop-dev] nothing running on :${report.port} (dev)`);
    return;
  }
  for (const s of report.spared) {
    console.log(`[stop-dev] spared pid ${s.pid} (${s.reason}): ${s.cmdline.slice(0, 110)}`);
  }
  for (const t of report.targets) {
    console.log(`[stop-dev] ${report.dryRun ? "would stop" : "stopped"} pid ${t.pid}: ${t.cmdline.slice(0, 110)}`);
  }
  const stillListening = listenersOn(report.port);
  if (!report.dryRun && stillListening.length) {
    console.error(`[stop-dev] WARNING: :${report.port} is still listening (pid ${stillListening.join(", ")})`);
    process.exit(1);
  }
  if (!report.dryRun) console.log(`[stop-dev] :${report.port} is free`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
