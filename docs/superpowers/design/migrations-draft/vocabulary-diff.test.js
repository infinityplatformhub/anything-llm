// T-1 vocabulary diff test (draft) — runtime home: server/__tests__/security/authorization/vocabulary-diff.test.js
// Contract with P0-4 (R3): every scope string used by requireScope() at runtime must exist in the
// seeded permissions vocabulary. Reads LIVE SOURCE so it enforces the contract regardless of which
// of P0-4 / T-1 merges first. New scope without a seeded permission fails with the exact string.
//
// ponytail: source-grep approach assumes requireScope("...") takes a string literal at the call
// site; if P0-4 ever computes scopes dynamically, switch to importing its scope registry instead.

const { execSync } = require("child_process");
const { ALL_ACTIONS } = require("../../../prisma/seeds/permissions");

function liveScopesFromSource() {
  const out = execSync(
    `grep -rhoE "requireScope\\\\((['\\"])([^'\\"]+)\\\\1" server/ --include="*.js" | sed -E "s/.*(['\\\"])([^'\\"]+)\\\\1/\\\\2/" | sort -u`,
    { encoding: "utf8" }
  );
  return out.split("\n").filter(Boolean);
}

describe("P0-4 scope strings ⊆ T-1 permission vocabulary", () => {
  test("every live requireScope() string is a seeded permission", () => {
    const missing = liveScopesFromSource().filter((s) => !ALL_ACTIONS.includes(s));
    expect(missing).toEqual([]);
  });

  test("seed vocabulary has no duplicate actions", () => {
    expect(new Set(ALL_ACTIONS).size).toBe(ALL_ACTIONS.length);
  });
});
