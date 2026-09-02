/**
 * S4a (#113): the Lark driver against a REAL fake Lark API.
 *
 * The property under test is not "does it fetch". It is what the driver does with a
 * page sequence it does not control — because Lark has no delta API, so a full
 * enumeration is the only source of truth, and S4b decides who has LEFT by who is
 * absent from it.
 *
 * That makes a short list the most dangerous value this driver can return. TL-1's
 * RF-1 shape is the one that matters: pages 1..36 succeed, 37 fails, 38..100 would
 * have succeeded. A driver that catches and returns what it collected hands back
 * 36 pages of "the truth", and everyone in pages 37..100 gets deactivated. Failing
 * on page 1 or on the last page is GREEN against that bug, which is why the fixture
 * fails in the middle.
 */

const { startLarkFixture } = require("../../../__testHelpers__/lark/server");
const {
  LarkIdentityProvider,
} = require("../../../utils/identityProviders/LarkIdentityProvider");
const {
  IdentityUnavailableError,
  IdentityCapabilityError,
} = require("../../../utils/identityProviders/errors");

let fixture;

afterEach(async () => {
  if (fixture) await fixture.close();
  fixture = null;
});

const driverFor = (fx, overrides = {}) =>
  new LarkIdentityProvider({
    appId: "cli_fixture",
    appSecret: "fixture-secret-never-logged",
    baseUrl: fx.baseUrl,
    maxRetries: 2,
    ...overrides,
  });

describe("S4a (#113) RF-1: a failed enumeration throws, and writes nothing", () => {
  test("5,000 principals across 100 pages are returned in full", async () => {
    // The positive half. Without it, "throws on failure" is satisfied by a driver
    // that throws always.
    fixture = await startLarkFixture({ users: 5000 });
    const driver = driverFor(fixture);

    const { principals, hasMore, nextCursor } = await driver.listPrincipals();

    expect(principals).toHaveLength(5000);
    expect(hasMore).toBe(false);
    expect(nextCursor).toBeNull();
    // Every page requested exactly once, in order — 100 requests could otherwise be
    // page 1 fetched a hundred times.
    expect(fixture.userPages).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1)
    );
  }, 60_000);

  test("a failure on page 37 REFUSES — it does not return 36 pages", async () => {
    fixture = await startLarkFixture({ users: 5000, failOnPage: 37 });
    const driver = driverFor(fixture);

    await expect(driver.listPrincipals()).rejects.toBeInstanceOf(
      IdentityUnavailableError
    );

    // The assertion that matters is not merely "it threw" — a driver could throw
    // AFTER handing a partial list to a caller that already stored it. Nothing
    // beyond page 37 was read, and no value escaped.
    const pagesRead = fixture.userPages;
    expect(pagesRead).toContain(36);
    expect(Math.max(...pagesRead)).toBe(37);
    expect(pagesRead).not.toContain(38);
  }, 60_000);

  test("the refusal names the failure and says no partial result was returned", async () => {
    // An operator reading this error must not go looking for the 36 pages.
    fixture = await startLarkFixture({ users: 5000, failOnPage: 37 });
    const driver = driverFor(fixture);
    await expect(driver.listPrincipals()).rejects.toThrow(/No partial result/);
  }, 60_000);

  test("a failure on the FIRST page also refuses — the boundary is not special", async () => {
    fixture = await startLarkFixture({ users: 500, failOnPage: 1 });
    const driver = driverFor(fixture);
    await expect(driver.listPrincipals()).rejects.toBeInstanceOf(
      IdentityUnavailableError
    );
  }, 60_000);

  test("a dropped socket mid-enumeration refuses rather than truncating", async () => {
    // Not every failure is an HTTP status. A killed connection is the shape that
    // most looks like "the directory ended here".
    fixture = await startLarkFixture({ users: 2000, failOnPage: 12, failMode: "drop" });
    const driver = driverFor(fixture);
    await expect(driver.listPrincipals()).rejects.toBeInstanceOf(
      IdentityUnavailableError
    );
  }, 60_000);
});

describe("S4a (#113) RF-2: a 429 is retried, and the retried page is not lost", () => {
  test("page 37 rate-limits once, then the full 5,000 arrive with page 37 intact", async () => {
    fixture = await startLarkFixture({
      users: 5000,
      failOnPage: 37,
      failMode: "429",
      failTimes: 1,
    });
    const driver = driverFor(fixture);

    const { principals } = await driver.listPrincipals();

    expect(principals).toHaveLength(5000);
    expect(fixture.failuresServed).toBe(1);

    // Named ids, not a count. A driver that skipped page 37 and read page 38 twice
    // also produces 5,000 rows — the count alone cannot tell those apart.
    // Page 37 is records 1800..1849 (zero-based, 50 per page).
    const subjects = principals.map((p) => p.subject);
    expect(subjects).toContain("u-01800");
    expect(subjects).toContain("u-01849");
    expect(new Set(subjects).size).toBe(5000); // and nothing was read twice

    // Page 37 was requested twice and every other page exactly once.
    const counts = fixture.userPages.reduce((acc, page) => {
      acc[page] = (acc[page] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts[37]).toBe(2);
    expect(counts[36]).toBe(1);
    expect(counts[38]).toBe(1);
  }, 60_000);

  test("a 429 that never clears refuses rather than returning what it had", async () => {
    fixture = await startLarkFixture({
      users: 5000,
      failOnPage: 37,
      failMode: "429",
      failTimes: Infinity,
    });
    const driver = driverFor(fixture);
    await expect(driver.listPrincipals()).rejects.toBeInstanceOf(
      IdentityUnavailableError
    );
  }, 60_000);
});

describe("S4a (#113) F2/F3: capabilities are honest, and the subject is user_id", () => {
  test("directorySync and groupSync are true, and the methods really work", async () => {
    // The mirror of the delta throw below: a flag claiming a capability the code
    // does not have is the dishonest-capability case seam 01 forbids, and so is a
    // method that throws while its flag says true.
    expect(LarkIdentityProvider.capabilities()).toMatchObject({
      directorySync: true,
      groupSync: true,
      deltaSync: false,
    });

    fixture = await startLarkFixture({ users: 10, departments: 4 });
    const driver = driverFor(fixture);
    await expect(driver.listPrincipals()).resolves.toMatchObject({ hasMore: false });
    await expect(driver.listGroups()).resolves.toMatchObject({ hasMore: false });
  }, 60_000);

  test("asking for a delta throws — deltaSync is false because Lark has none", async () => {
    fixture = await startLarkFixture({ users: 10 });
    const driver = driverFor(fixture);
    await expect(driver.listPrincipals({ delta: true })).rejects.toBeInstanceOf(
      IdentityCapabilityError
    );
  }, 60_000);

  test("the subject is user_id, taken from the real response", async () => {
    // F3: asserted against what the server actually sent, not against a constant.
    // The fixture serves `open_id` as `ou_MUST_NOT_BE_USED_<n>`, so a driver keying
    // on it produces a visibly wrong subject instead of a plausible one.
    fixture = await startLarkFixture({ users: 3 });
    const driver = driverFor(fixture);
    const { principals } = await driver.listPrincipals();

    expect(principals[0].subject).toBe("u-00000");
    expect(principals.every((p) => p.subject.startsWith("u-"))).toBe(true);
    expect(principals.some((p) => p.subject.includes("MUST_NOT_BE_USED"))).toBe(false);
  }, 60_000);

  test("open_id appears nowhere in the driver source", async () => {
    // Belt and braces to the test above, and the reason is permanence: `open_id` is
    // per-application, so once identity_links rows exist, re-registering the app
    // means re-linking every person. Comments are stripped first — a prohibition
    // written in a comment must not satisfy its own grep.
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.join(
        __dirname,
        "../../../utils/identityProviders/LarkIdentityProvider/index.js"
      ),
      "utf8"
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/open_id/);
  });
});

describe("S4a (#113) RF-4: address selection, decided in advance", () => {
  test("enterprise_email wins when both are present and differ", async () => {
    // enterprise_email is domain-verified at the tenant level and therefore the
    // stronger claim. The fixture gives every third user an empty one, so both
    // branches are exercised by one enumeration.
    fixture = await startLarkFixture({ users: 6 });
    const driver = driverFor(fixture);
    const { principals } = await driver.listPrincipals();

    // user 1: enterprise present, and it differs from `email`
    expect(principals[1].email).toBe("user1@corp.example.com");
    // user 0, 3: enterprise empty -> falls back to the personal address
    expect(principals[0].email).toBe("user0@example.com");
    expect(principals[3].email).toBe("user3@example.com");
  }, 60_000);

  test("neither address present yields email null — the driver does not invent one", async () => {
    // Quarantine is the RECONCILER's decision (S4b). What is asserted here is that
    // the driver reports the absence rather than fabricating a plausible address,
    // which would make an unmatched person silently matchable.
    const row = LarkIdentityProvider.toDirectoryPrincipal({
      user_id: "u-x",
      email: "",
      enterprise_email: "",
      name: "No Address",
    });
    expect(row.email).toBeNull();
    expect(row.subject).toBe("u-x");
  });

  test("emailVerified is reported false — Lark has no verified semantics", async () => {
    // Neither field means "this was proven". Claiming true here would launder a
    // directory record into a verified address; the trust decision belongs to core's
    // sync path (recon §7.3), not to the driver.
    const row = LarkIdentityProvider.toDirectoryPrincipal({
      user_id: "u-y",
      enterprise_email: "person@corp.example.com",
    });
    expect(row.emailVerified).toBe(false);
  });
});

describe("S4a (#113): the app secret does not escape", () => {
  test("it is absent from toJSON, inspect, and a thrown configuration error", async () => {
    const secret = "fixture-secret-never-logged";
    fixture = await startLarkFixture({ users: 1 });
    const driver = driverFor(fixture);

    expect(JSON.stringify(driver)).not.toContain(secret);
    expect(require("util").inspect(driver)).not.toContain(secret);

    // And when the enumeration fails, the message must not echo the secret back.
    // Pointed at a dead port so the failure is real: an earlier version of this test
    // used a bad PATH, and the fixture matched it anyway — the driver returned data
    // and the assertion passed for the wrong reason.
    const unreachable = new LarkIdentityProvider({
      appId: "cli_x",
      appSecret: secret,
      baseUrl: "http://127.0.0.1:1",
      maxRetries: 0,
    });

    const error = await unreachable.listPrincipals().then(
      () => {
        throw new Error("expected the enumeration to fail");
      },
      (caught) => caught
    );
    expect(error).toBeInstanceOf(IdentityUnavailableError);
    // The whole error, not just its top-level message: `cause` is where a fetch
    // failure carries the request it was making.
    const rendered = `${error.message}\n${require("util").inspect(error, { depth: 5 })}`;
    expect(rendered).not.toContain(secret);
  }, 60_000);
});

describe("S4a (#113) RF-6/RF-7: a snapshot is complete, or it is an error", () => {
  test("RF-7: a cursor is REFUSED — a resumed enumeration is a prefix wearing a full label", async () => {
    // Measured before the fix, on this exact fixture shape:
    //   listPrincipals({ cursor: "4" }) → 235 of 250, hasMore false, nextCursor null
    // Every field said the enumeration finished cleanly, and a reconciler acting on
    // it would deactivate the 15 people that were skipped. Silently ignoring the
    // argument is worse than refusing: the caller believes it resumed AND got
    // everything.
    fixture = await startLarkFixture({ users: 250, pageSize: 5 });
    const driver = driverFor(fixture, { pageSize: 5 });

    await expect(driver.listPrincipals({ cursor: "4" })).rejects.toBeInstanceOf(
      IdentityCapabilityError
    );
    await expect(driver.listGroups({ cursor: "4" })).rejects.toBeInstanceOf(
      IdentityCapabilityError
    );

    // And the honest call still works, so the refusal is about the cursor rather
    // than about the driver being broken.
    await expect(driver.listPrincipals()).resolves.toMatchObject({ hasMore: false });
  }, 60_000);

  test("RF-6: a page_token on the LAST page does not cause a second read", async () => {
    // Real APIs return a token on every page. A driver that loops on "is there a
    // token" rather than on `has_more` re-reads the final page forever. The default
    // fixture omits the trailing token, so this guard had no test at all.
    fixture = await startLarkFixture({ users: 120, pageSize: 50, alwaysToken: true });
    const driver = driverFor(fixture, { pageSize: 50 });

    const { principals } = await driver.listPrincipals();

    expect(principals).toHaveLength(120);
    // Three pages, each exactly once — not a fourth read of page 3, and not a loop.
    expect(fixture.userPages).toEqual([1, 2, 3]);
    expect(new Set(principals.map((p) => p.subject)).size).toBe(120);
  }, 60_000);

  test("NIT-2: a record with no user_id is refused, not skipped", async () => {
    // Skipping is the quieter option and the wrong one. `identity_links` is unique
    // on (provider, subject), so two records normalizing to "" collide on the field
    // that IS the identity — and a skipped principal is ABSENT from the snapshot,
    // which is precisely how the reconciler decides someone has left.
    expect(() =>
      LarkIdentityProvider.toDirectoryPrincipal({
        user_id: "",
        name: "No Id",
        email: "noid@example.com",
      })
    ).toThrow(IdentityUnavailableError);

    // Whitespace is not an id either.
    expect(() =>
      LarkIdentityProvider.toDirectoryPrincipal({ user_id: "   ", name: "Blank" })
    ).toThrow(IdentityUnavailableError);
  });
});
