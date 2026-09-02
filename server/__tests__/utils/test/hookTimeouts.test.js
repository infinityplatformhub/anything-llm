/**
 * #142/#143 — a teardown hook that drops a database or closes a server must carry an
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
 *
 * #143 — SHAPES. The first version matched `afterAll(async () => {` alone, and that
 * single-form scan is the defect this issue closed: QA-2 counted 88 hooks in that
 * shape and 11 outside it, and one of the 11
 * (`endpoints/removeAndUnembedHttp.test.js:90`, `afterAll((done) => …)` closing a
 * server) was untimed the whole time the guard reported green. A checker that
 * enumerates ONE syntactic form silently exempts every other form, and the exemption
 * is invisible precisely because the check passes — the same drift as #139's .nvmrc.
 *
 * So the opener is matched by its ARGUMENT LIST rather than by one spelling: any
 * `afterAll`/`afterEach` whose callback is an arrow (`() =>`, `(done) =>`, `async
 * (done) =>`) or a `function`. The forms that exist today are listed in the CONTROL
 * below, and a form nobody has written yet fails toward being scanned rather than
 * toward being skipped.
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
 * The body of every `afterAll`/`afterEach` hook plus whatever follows its closing
 * brace, found by BRACE MATCHING rather than by a regex over the whole hook.
 *
 * A regex cannot do this correctly: hook bodies contain nested braces, template
 * literals and object literals, and a lazy `[\s\S]*?\}` stops at the first inner
 * brace — which reads the timeout argument off the wrong closing paren and passes
 * everything.
 *
 * The opener deliberately does not enumerate spellings. It accepts an optional
 * `async`, then either a parenthesised parameter list (empty, `(done)`, anything) or
 * a bare identifier, then `=>` or a `function` keyword — so `afterAll(async () => {`,
 * `afterAll((done) => {`, `afterAll(done => {`, `afterAll(function () {` and
 * `afterAll(async function (done) {` are all one rule. #143: the previous version
 * spelled out one of these and silently exempted the rest.
 */
function teardownHooks(source) {
  const hooks = [];
  // Comments are blanked, not removed, so every line number below still points at the
  // real line. Found by the scanner reporting a hook that does not exist: the #143 fix
  // comment on `removeAndUnembedHttp.test.js` contains the text
  // "afterAll(async () => {" as PROSE, and the scanner matched it, then brace-matched
  // into the code beneath and reported the file as an offender three lines above its
  // actual hook. A checker that cannot tell code from a comment about code will fire
  // on any file that documents this rule.
  source = source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (line) => line.replace(/[^\n]/g, " "));
  const opener =
    /\b(afterAll|afterEach)\(\s*(?:async\s+)?(?:function\s*\w*\s*)?(?:\([^)]*\)|\w+)\s*(?:=>\s*)?\{/g;
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
      hook: match[1],
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
      for (const hook of teardownHooks(source)) {
        const reasons = SLOW.filter((s) => hook.body.includes(s.needle));
        if (reasons.length === 0) continue;
        // `}, 30_000);` — an argument after the closing brace
        if (/^\s*,\s*[\d_]+\s*\)/.test(hook.tail)) continue;
        offenders.push(
          `${path.relative(TESTS_DIR, file)}:${hook.line} — ${reasons
            .map((r) => r.why)
            .join(" and ")} in ${hook.hook} with no timeout (jest default is 5s)`
        );
      }
    }
    // Named, not counted: a count tells the next person that something is wrong and
    // nothing about where, and the whole point of this file is that the failure mode
    // is hard to recognise from its symptom.
    // COVERAGE (#143): arrow, callback-arrow and `function` forms of both `afterAll`
    // and `afterEach`. What is still unscanned is a hook whose slow work is inside a
    // helper this file cannot see — the scanner reads text, not a call graph.
    expect(offenders).toEqual([]);
  });

  test("CONTROL: the matcher finds an untimed slow hook in EVERY shape", () => {
    // Without this, a broken matcher that returns no hooks at all makes the test
    // above pass forever — green because it examined nothing. §7.17's class.
    //
    // #143: one sample per shape, because that is exactly what the previous version
    // got wrong. A CONTROL covering only the arrow form would have gone green against
    // the single-shape scanner that let `removeAndUnembedHttp:90` drift untimed.
    const sample = `
      afterAll(async () => {
        const nested = { a: { b: 1 } };
        await admin.$executeRawUnsafe(\`DROP DATABASE IF EXISTS "x" WITH (FORCE)\`);
      });
      afterAll((done) => {
        server.close(done);
      });
      afterAll(function () {
        server.close();
      });
      afterEach(async () => {
        await admin.$executeRawUnsafe(\`DROP DATABASE IF EXISTS "y"\`);
      });
      afterAll(async () => {
        await new Promise((r) => server.close(r));
      }, 30_000);
    `;
    const hooks = teardownHooks(sample);
    expect(hooks).toHaveLength(5);

    const untimed = (h) => !/^\s*,\s*[\d_]+\s*\)/.test(h.tail);
    // the four slow, untimed ones — one per shape
    expect(hooks[0].body).toContain("DROP DATABASE");
    expect(untimed(hooks[0])).toBe(true);
    expect(hooks[1].body).toContain("server.close"); // (done) => callback form
    expect(untimed(hooks[1])).toBe(true);
    expect(hooks[2].body).toContain("server.close"); // function form
    expect(untimed(hooks[2])).toBe(true);
    expect(hooks[3].hook).toBe("afterEach"); // afterEach is scanned too
    expect(untimed(hooks[3])).toBe(true);
    // ...and the timed one is not reported
    expect(hooks[4].body).toContain("server.close");
    expect(untimed(hooks[4])).toBe(false);
  });

  test("CONTROL: a hook mentioned in a COMMENT is not a hook", () => {
    // Measured, not anticipated: the first version of the #143 fix comment on
    // `removeAndUnembedHttp.test.js` contains "afterAll(async () => {" as prose, and
    // the scanner matched it and reported that file as an offender — a false kill on
    // the very file it had just fixed. Any file that documents this rule would trip it.
    const sample = `
      // afterAll(async () => { server.close(); });   <- prose, not code
      /* afterEach(() => { DROP DATABASE }); */
      afterAll(async () => {
        await new Promise((r) => server.close(r));
      }, 30_000);
    `;
    const hooks = teardownHooks(sample);
    expect(hooks).toHaveLength(1);
    expect(/^\s*,\s*[\d_]+\s*\)/.test(hooks[0].tail)).toBe(true);
  });
});
