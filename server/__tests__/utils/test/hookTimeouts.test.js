/**
 * #142 — a teardown hook that drops a database or closes a server must carry an
 * explicit timeout.
 *
 * WHY THIS IS A STRUCTURAL TEST AND NOT A BEHAVIOURAL ONE. The defect it guards is
 * load-dependent, and I measured that both ways rather than guessing:
 *
 *   assignableRolesHttp, untimed afterAll, machine busy (3 concurrent suites)
 *     -> `Exceeded timeout of 5000 ms for a hook`, suite FAILED, exit 1
 *   assignableRolesHttp, untimed afterAll, machine idle, four consecutive runs
 *     -> passed every time, exit 0, no hook timeout
 *
 * So a fixture that runs the suite and asserts it passes CANNOT witness the bug: on
 * an idle machine the untimed hook finishes in ~50 ms and the mutation survives. The
 * property that is always true is the one asserted here — the hook declares a
 * timeout — and it is checkable without depending on how loaded the machine is.
 *
 * WHAT THE FAILURE LOOKS LIKE, because it is not self-describing. Jest reports
 * `● Test suite failed to run` with exit 1 while every test in the file PASSES. Read
 * quickly, that is indistinguishable from an import-time crash — which is how #142
 * was originally filed (as `jsonwebtoken` failing to load on node 22 via
 * `buffer-equal-constant-time` reading `SlowBuffer.prototype`). Measured: under
 * jest's `node` environment `require("buffer").SlowBuffer` is a function with a
 * prototype, and `jsonwebtoken` imports clean; the two suites named in that report
 * run 18 and 11 tests respectively. The import failure was not the defect.
 *
 * SCOPE. Only hooks that do something slow and external: `DROP DATABASE` (which
 * blocks on other connections and competes with every other worktree's gate against
 * the same server) or closing an HTTP server with live connections. A hook that only
 * disconnects a pool is fast and bounded, and demanding a timeout on all 42 of them
 * would be noise that gets suppressed rather than a guard that holds.
 */

const fs = require("fs");
const path = require("path");

const TESTS_DIR = path.resolve(__dirname, "../..");

function walk(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.name.endsWith(".test.js")) found.push(full);
  }
  return found;
}

/**
 * The body of each `afterAll(async () => { ... })` plus whatever follows its closing
 * brace, found by BRACE MATCHING rather than by a regex over the whole hook.
 *
 * A regex cannot do this correctly: hook bodies contain nested braces, template
 * literals and object literals, and a lazy `[\s\S]*?\}` stops at the first inner
 * brace — which reads the timeout argument off the wrong closing paren and passes
 * everything.
 */
function afterAllHooks(source) {
  const hooks = [];
  const opener = /afterAll\(\s*async\s*\(\s*\)\s*=>\s*\{/g;
  let match;
  while ((match = opener.exec(source)) !== null) {
    let index = opener.lastIndex;
    let depth = 1;
    while (depth > 0 && index < source.length) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") depth -= 1;
      index += 1;
    }
    hooks.push({
      body: source.slice(opener.lastIndex, index),
      tail: source.slice(index, index + 20),
      line: source.slice(0, match.index).split("\n").length,
    });
  }
  return hooks;
}

const SLOW = [
  { needle: "DROP DATABASE", why: "drops a database" },
  { needle: "server.close", why: "closes an HTTP server" },
];

describe("#142: teardown hooks that do slow external work declare a timeout", () => {
  test("every such afterAll passes an explicit timeout argument", () => {
    const offenders = [];
    for (const file of walk(TESTS_DIR)) {
      // This file's own CONTROL holds a sample hook as a string literal, which the
      // scanner cannot tell from a real one — it reads text, not an AST. Skipping
      // itself is honest about that limit; the alternative is a scanner that parses
      // JavaScript, which is a much larger thing to get right for one guard.
      if (path.resolve(file) === path.resolve(__filename)) continue;
      const source = fs.readFileSync(file, "utf8");
      for (const hook of afterAllHooks(source)) {
        const reasons = SLOW.filter((s) => hook.body.includes(s.needle));
        if (reasons.length === 0) continue;
        // `}, 30_000);` — an argument after the closing brace
        if (/^\s*,\s*[\d_]+\s*\)/.test(hook.tail)) continue;
        offenders.push(
          `${path.relative(TESTS_DIR, file)}:${hook.line} — ${reasons
            .map((r) => r.why)
            .join(" and ")} with no timeout (jest default is 5s)`
        );
      }
    }
    // Named, not counted: a count tells the next person that something is wrong and
    // nothing about where, and the whole point of this file is that the failure mode
    // is hard to recognise from its symptom.
    // COVERAGE LIMIT: this scans the `afterAll(async () => {` shape only. Callback and
    // plain-function forms and every `afterEach` go unscanned — known untimed today:
    // `endpoints/removeAndUnembedHttp.test.js:90`, `afterAll((done) => …)` closing a
    // server, left for a follow-up issue rather than widened here.
    expect(offenders).toEqual([]);
  });

  test("CONTROL: the matcher actually finds an untimed slow hook", () => {
    // Without this, a broken brace-matcher that returns no hooks at all makes the
    // test above pass forever — green because it examined nothing. §7.17's class.
    const sample = `
      afterAll(async () => {
        const nested = { a: { b: 1 } };
        await admin.$executeRawUnsafe(\`DROP DATABASE IF EXISTS "x" WITH (FORCE)\`);
      });
      afterAll(async () => {
        await new Promise((r) => server.close(r));
      }, 30_000);
    `;
    const hooks = afterAllHooks(sample);
    expect(hooks).toHaveLength(2);
    // the first is untimed and slow -> would be reported
    expect(hooks[0].body).toContain("DROP DATABASE");
    expect(/^\s*,\s*[\d_]+\s*\)/.test(hooks[0].tail)).toBe(false);
    // the second is slow but timed -> would not
    expect(hooks[1].body).toContain("server.close");
    expect(/^\s*,\s*[\d_]+\s*\)/.test(hooks[1].tail)).toBe(true);
  });
});
