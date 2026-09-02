/* eslint-env jest */

/**
 * O2b (#112) — the preflight STEP's two decisions.
 *
 * The frontend has no test runner (`frontend/package.json` has no test script
 * and neither jest nor vitest is installed), so the component's rendering is
 * not covered here and that is stated rather than implied. What IS covered is
 * the pure logic the step's correctness rests on, imported from the component
 * file so a change there fails this rather than drifting from a copy:
 *
 *   - which checks stop the step (`blockersOf`)
 *   - which dot a check gets (`dotFor`)
 *
 * Both exist as exported functions for exactly this reason.
 */
const fs = require("fs");
const path = require("path");

const COMPONENT = path.join(
  __dirname,
  "../../../frontend/src/pages/OnboardingFlow/Steps/Preflight/index.jsx"
);

// The component is ESM/JSX and cannot be `require`d here. Its two pure helpers
// are extracted and evaluated instead — the alternative is a second copy, which
// is what these tests exist to prevent.
function loadHelpers() {
  const source = fs.readFileSync(COMPONENT, "utf8");
  const dotFor = source.slice(
    source.indexOf("export function dotFor"),
    source.indexOf("/** A check that is not ok")
  );
  const blockersOf = source.slice(
    source.indexOf("export const blockersOf"),
    source.indexOf("export default function")
  );
  const src = `${dotFor}\n${blockersOf}\nreturn { dotFor, blockersOf };`
    .replace(/export function/g, "function")
    .replace(/export const/g, "const");
  // eslint-disable-next-line no-new-func
  return new Function(src)();
}

const { dotFor, blockersOf } = loadHelpers();

describe("which checks stop the step", () => {
  const check = (id, ok, level) => ({ id, ok, level, detail: id, remedy: "" });

  it("treats a failed BLOCKING check as a blocker", () => {
    expect(blockersOf([check("db.reachable", false, "block")])).toHaveLength(1);
  });

  it("does NOT treat a failed WARNING as a blocker", () => {
    // The mockup's contract: blocking blocks, warn does not. #90's metrics
    // exposure check is a warn, and an install whose /metrics is reachable is
    // still an install that works.
    expect(blockersOf([check("config.metrics_exposure", false, "warn")])).toEqual(
      []
    );
  });

  it("ignores checks that passed, whatever their level", () => {
    expect(
      blockersOf([
        check("db.reachable", true, "block"),
        check("config.metrics_exposure", true, "warn"),
      ])
    ).toEqual([]);
  });

  it("returns the blockers in order, so the bar can name the first one", () => {
    // The mockup names the blocker rather than counting: "3 of 9 passed" tells
    // an operator nothing they can act on.
    const blockers = blockersOf([
      check("env.writable", true, "block"),
      check("db.reachable", false, "block"),
      check("ext.available", false, "block"),
    ]);
    expect(blockers.map((b) => b.id)).toEqual(["db.reachable", "ext.available"]);
  });

  it("takes level from the SERVER, not from the id or the ok flag", () => {
    // A second classification in the frontend would let the UI and the boot
    // gate disagree about the same instance. Same id, different level,
    // different answer.
    const id = "some.check";
    expect(blockersOf([check(id, false, "block")])).toHaveLength(1);
    expect(blockersOf([check(id, false, "warn")])).toHaveLength(0);
  });
});

describe("which dot a check gets", () => {
  it("ok, warn and bad are three different states", () => {
    expect(dotFor({ ok: true, level: "block" })).toBe("ok");
    expect(dotFor({ ok: false, level: "warn" })).toBe("warn");
    expect(dotFor({ ok: false, level: "block" })).toBe("bad");
  });

  it("a missing check is idle, not ok", () => {
    // The one wrong answer a preflight must never give is a green tick for
    // something it never checked.
    expect(dotFor(undefined)).toBe("idle");
    expect(dotFor(null)).toBe("idle");
  });
});

describe("the step is wired where the recon says", () => {
  const read = (rel) =>
    fs.readFileSync(path.join(__dirname, "../../../frontend/src", rel), "utf8");

  it("sits before llm-preference in the flow, not after", () => {
    // A preflight shown after the LLM is configured is a post-mortem — the
    // ordering mistake #74's entrypoint avoids by running the doctor before
    // `prisma migrate deploy`.
    expect(read("pages/OnboardingFlow/Steps/Home/index.jsx")).toContain(
      "paths.onboarding.preflight()"
    );
    expect(
      read("pages/OnboardingFlow/Steps/LLMPreference/index.jsx")
    ).toContain("paths.onboarding.preflight()");
    expect(read("pages/OnboardingFlow/Steps/index.jsx")).toContain(
      "preflight: Preflight"
    );
  });

  it("returns null rather than an empty list when the request fails", () => {
    // An empty array renders as "every check passed", which is the one wrong
    // answer. The model must let the caller tell "could not ask" from "asked
    // and all clear".
    const model = read("models/system.js");
    const preflight = model.slice(
      model.indexOf("preflight: async function"),
      model.indexOf("markOnboardingComplete")
    );
    expect(preflight).toContain(".catch(() => null)");
    expect(preflight).not.toMatch(/catch\(\(\) => \[\]\)/);
  });
});
