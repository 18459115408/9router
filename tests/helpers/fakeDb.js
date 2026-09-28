// An in-memory stand-in for the SQLite adapter, covering only the kv-shaped
// SQL the model-config repos run. Tests that would otherwise read and write
// the live ~/.9router database get a private one instead:
//
//   • no residue when a run is interrupted mid-test (a real-DB write that
//     crashes before its afterAll leaves the row behind for good);
//   • no dependence on rows a manual migration happened to leave on this
//     machine — every file runs identically on a fresh install and in CI;
//   • no SQLITE_BUSY when vitest runs files in parallel against one file.

const rows = new Map(); // `${scope}\u0000${key}` → JSON string
const meta = new Map(); // `_meta` key → value (metaStore's own table)

const keyOf = (scope, key) => `${scope}\u0000${key}`;

// The repos spell the scope both as a bound parameter and as a quoted literal
// — the same statement shape from different call sites, with the literal in
// whichever position the statement happens to use. Lift literals into the
// parameter list, in position, so one matcher serves every spelling instead of
// two regexes per statement.
function normalize(sql, params = []) {
  const literals = [];
  const marked = sql.replace(/'([^']*)'/g, (_, lit) => {
    literals.push(lit);
    return "\u0000";
  });
  const args = [];
  let pi = 0;
  const normalized = marked.replace(/\u0000|\?/g, (token) => {
    args.push(token === "\u0000" ? literals.shift() : params[pi++]);
    return "?";
  });
  return { sql: normalized, params: args };
}

// Only these shapes are served. A statement this file does not recognize
// throws rather than passing silently — a fake that answers everything makes a
// repo change look tested when it is not.
const STATEMENTS = [
  [/^SELECT value FROM kv WHERE scope = \? AND key = \?$/, "select-one"],
  [/^SELECT key, value FROM kv WHERE scope = \?$/, "select-all"],
  [/^INSERT INTO kv\(scope, key, value\) VALUES\(\?, \?, \?\) ON CONFLICT\(scope, key\) DO UPDATE SET value = excluded\.value$/, "upsert"],
  [/^INSERT INTO kv\(scope, key, value\) VALUES\(\?, \?, \?\)$/, "insert"],
  [/^UPDATE kv SET value = \? WHERE scope = \? AND key = \?$/, "update"],
  [/^DELETE FROM kv WHERE scope = \? AND key = \?$/, "delete-one"],
  [/^DELETE FROM kv WHERE scope = \?$/, "delete-scope"],
  [/^SELECT value FROM _meta WHERE key = \?$/, "select-meta"],
  [/^INSERT INTO _meta\(key, value\) VALUES\(\?, \?\) ON CONFLICT\(key\) DO UPDATE SET value = excluded\.value$/, "upsert-meta"],
];

function serve(sql, params) {
  const { sql: norm, params: args } = normalize(sql, params);
  const [matched, kind] = STATEMENTS.find(([re]) => re.test(norm)) || [];
  if (!matched) throw new Error(`fakeDb: unhandled SQL: ${sql}`);
  if (kind === "select-one") {
    const value = rows.get(keyOf(args[0], args[1]));
    return { kind, row: value === undefined ? undefined : { value } };
  }
  if (kind === "select-meta") {
    const value = meta.get(args[0]);
    return { kind, row: value === undefined ? undefined : { value } };
  }
  return { kind, args };
}

const adapter = {
  driver: "fake-memory",
  get(sql, params = []) {
    const { kind, row } = serve(sql, params);
    if (kind !== "select-one" && kind !== "select-meta") {
      throw new Error(`fakeDb: get() only serves SELECT value: ${sql}`);
    }
    return row;
  },
  all(sql, params = []) {
    const { kind, args } = serve(sql, params);
    if (kind !== "select-all") throw new Error(`fakeDb: all() only serves SELECT key, value: ${sql}`);
    const prefix = `${args[0]}\u0000`;
    const out = [];
    for (const [k, value] of rows) {
      if (k.startsWith(prefix)) out.push({ key: k.slice(prefix.length), value });
    }
    return out;
  },
  run(sql, params = []) {
    const { kind, args } = serve(sql, params);
    if (kind === "upsert" || kind === "insert") {
      rows.set(keyOf(args[0], args[1]), args[2]);
      return { changes: 1, lastInsertRowid: 0 };
    }
    if (kind === "update") {
      // Placeholder order is [value, scope, key] — whichever spelling the
      // statement used, normalize() has put them in that order.
      const k = keyOf(args[1], args[2]);
      if (!rows.has(k)) return { changes: 0, lastInsertRowid: 0 };
      rows.set(k, args[0]);
      return { changes: 1, lastInsertRowid: 0 };
    }
    if (kind === "delete-one") {
      const had = rows.delete(keyOf(args[0], args[1]));
      return { changes: had ? 1 : 0, lastInsertRowid: 0 };
    }
    if (kind === "delete-scope") {
      const prefix = `${args[0]}\u0000`;
      let changes = 0;
      for (const k of [...rows.keys()]) {
        if (k.startsWith(prefix)) {
          rows.delete(k);
          changes += 1;
        }
      }
      return { changes, lastInsertRowid: 0 };
    }
    if (kind === "upsert-meta") {
      meta.set(args[0], args[1]);
      return { changes: 1, lastInsertRowid: 0 };
    }
    throw new Error(`fakeDb: run() got a read statement: ${sql}`);
  },
  // The repos rely on a transaction rolling back on throw, so a throwing fn
  // must not leave partial writes behind.
  transaction(fn) {
    const snapshot = new Map(rows);
    try {
      return fn();
    } catch (error) {
      rows.clear();
      for (const [k, v] of snapshot) rows.set(k, v);
      throw error;
    }
  },
};

export async function getAdapter() {
  return adapter;
}

export function getAdapterSync() {
  return adapter;
}

/** Drop every row. Call in beforeEach so each test starts from an empty store. */
export function __resetFakeDb() {
  rows.clear();
  meta.clear();
}

/** Seed one kv row directly, the way the migration or another process would. */
export function __seedFakeDb(scope, key, value) {
  rows.set(keyOf(scope, key), typeof value === "string" ? value : JSON.stringify(value));
}
