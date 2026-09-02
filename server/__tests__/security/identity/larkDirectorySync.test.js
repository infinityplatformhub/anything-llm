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

/**
 * #138 R2a: the request timeout, and why a concurrency issue starts in the driver.
 *
 * TL-1's lease rule for slice 3 is "the lease must exceed the longest plausible stall
 * in a SINGLE driver call". That number could not be derived, because the stall was
 * unbounded: `_page` forwards an optional `signal` that no production caller supplies,
 * and `_tenantAccessToken` had no signal at all. The retry loop covers a DROPPED
 * socket; a socket that stays open and never answers is not a dropped socket.
 *
 * Why it matters: an unbounded request makes the sync job run forever. The job never
 * completes, its worker slot is held indefinitely, and the directory silently stops
 * syncing while every dashboard reports a run in progress.
 *
 * NOT because it triggers a lease takeover. An earlier version of this comment said a
 * hung fetch stops the heartbeat and lets a second worker start a concurrent apply;
 * TL-1 measured that false — `setInterval` keeps firing while a promise is awaited (9
 * beats during a hung request), so the lease keeps renewing. Takeover covers a killed,
 * wedged or event-loop-starved process, not one politely waiting on a socket.
 *
 * The fixture ACCEPTS the connection and never answers. A dead port is not a
 * substitute: it rejects instantly, so a driver with no timeout is green against it.
 */
describe("#138 R2a: an unanswered request is bounded, not waited on forever", () => {
  test("a Lark tenant that accepts and never answers makes listPrincipals reject", async () => {
    fixture = await startLarkFixture({
      users: 100,
      pageSize: 50,
      failOnPage: 1,
      failMode: "hang",
      failTimes: Infinity,
    });
    // Small explicit numbers so the bound is provable rather than approximately
    // observed: 4 attempts x 150ms, plus backoff, is comfortably inside the jest
    // timeout below. Without the timeout this call never settles and the test fails
    // by TIMING OUT — which is the RED state, and is what the mutant reproduces.
    const driver = driverFor(fixture, {
      pageSize: 50,
      maxRetries: 3,
      timeoutMs: 150,
    });

    const started = Date.now();
    await expect(driver.listPrincipals()).rejects.toThrow(IdentityUnavailableError);
    const elapsed = Date.now() - started;

    // Bounded ABOVE: the whole retry sequence finished. The ceiling is loose on
    // purpose — the assertion is "it terminated", not a stopwatch on CI.
    expect(elapsed).toBeLessThan(10_000);

    // And bounded BELOW, which is the half that would otherwise pass for the wrong
    // reason: a driver that gave up after ONE attempt also "rejects quickly", and
    // would lose the retry behaviour #113 built. Four attempts at 150ms cannot
    // finish in under 300ms.
    expect(elapsed).toBeGreaterThan(300);

    // It really did retry, rather than failing once: 1 initial + 3 retries.
    expect(fixture.userPages.filter((p) => p === 1)).toHaveLength(4);
  }, 30_000);

  test("a hung TOKEN endpoint is bounded too — the call every enumeration makes first", async () => {
    // `_tenantAccessToken` runs before any page is fetched, so a timeout on `_page`
    // alone leaves the whole run stalled before it starts. Bounding one and not the
    // other looks correct in review and fails identically in production.
    fixture = await startLarkFixture({ users: 10, hangToken: true });
    const driver = driverFor(fixture, { timeoutMs: 150 });

    const started = Date.now();
    await expect(driver.listPrincipals()).rejects.toThrow(IdentityUnavailableError);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  test("a caller's own signal still aborts, and is not overwritten by the timeout", async () => {
    // The timeout must COMBINE with a caller's signal, never replace it. Replacing it
    // is the plausible implementation (`signal: AbortSignal.timeout(ms)`), and it
    // silently removes the caller's ability to cancel — which slice 3 will rely on to
    // stop a sync on shutdown.
    fixture = await startLarkFixture({
      users: 100,
      pageSize: 50,
      failOnPage: 1,
      failMode: "hang",
      failTimes: Infinity,
    });
    // A LONG timeout, so anything that settles quickly settled because of the
    // caller's abort and not because the timeout fired.
    const driver = driverFor(fixture, { pageSize: 50, timeoutMs: 30_000 });

    const controller = new AbortController();
    const pending = driver.listPrincipals({ signal: controller.signal });
    setTimeout(() => controller.abort(), 100);

    const started = Date.now();
    await expect(pending).rejects.toThrow(IdentityUnavailableError);
    // Well under the 30s timeout: the caller's signal is what ended it.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  test("Retry-After cannot make the driver sleep unboundedly", async () => {
    // The second hole TL-1 named. A 429 carrying `Retry-After: 86400` is honoured
    // verbatim today, so a rate-limited tenant parks the run for a day — the same
    // stalled-lease outcome as a hung socket, arriving through a header instead.
    fixture = await startLarkFixture({
      users: 100,
      pageSize: 50,
      failOnPage: 1,
      failMode: "429",
      failTimes: 1,
      retryAfterSeconds: 86_400,
    });
    const driver = driverFor(fixture, { pageSize: 50, maxRetries: 2, timeoutMs: 1_000 });

    const started = Date.now();
    const { principals } = await driver.listPrincipals();
    const elapsed = Date.now() - started;

    // It waited (the clamp is a ceiling, not a bypass) and then SUCCEEDED — the
    // retry still works, which a test asserting only "it was fast" would not show.
    expect(principals).toHaveLength(100);
    expect(elapsed).toBeLessThan(60_000);
  }, 90_000);
});

/**
 * #138: witnesses for the two implementation rulings the timeout forced.
 *
 * Both are cases where the driver has a bounded timeout and is still wrong, so the
 * hang tests above are green against either bug. They need their own fixtures.
 */
describe("#138: the timeout's two implementation rulings", () => {
  test("a fresh signal per ATTEMPT — one hoisted signal starves the retries", async () => {
    // `AbortSignal.timeout` starts counting when it is CREATED. A signal built once
    // above the retry loop gives all four attempts a single shared deadline: attempt
    // 1 consumes it and attempts 2-4 get an already-aborted signal, so they fail
    // instantly without ever reaching Lark.
    //
    // The fixture: page 1 hangs ONCE, then answers. A per-attempt signal recovers;
    // one shared signal cannot. A fixture that hangs forever is red under both
    // implementations and proves nothing about which.
    fixture = await startLarkFixture({
      users: 60,
      pageSize: 50,
      failOnPage: 1,
      failMode: "hang",
      failTimes: 1,
    });
    const driver = driverFor(fixture, { pageSize: 50, maxRetries: 3, timeoutMs: 400 });

    const { principals } = await driver.listPrincipals();

    // It recovered: attempt 2 had a full budget of its own. Under a hoisted signal
    // the enumeration dies here instead, because attempt 2 starts already aborted.
    expect(principals).toHaveLength(60);
    // Page 1 was tried twice (hung, then served).
    expect(fixture.userPages.filter((p) => p === 1).length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  test("a caller's cancel is NOT retried — one attempt, then stop", async () => {
    // A deliberate cancel and a request timeout arrive as the IDENTICAL error, so
    // the driver tells them apart by whose signal fired. Get that wrong and a
    // shutdown cancel is retried three more times, keeping the process doing work
    // somebody explicitly stopped.
    //
    // This is the assertion the hang tests cannot make: they never cancel, so a
    // driver that retries a cancel is green against all of them.
    fixture = await startLarkFixture({
      users: 100,
      pageSize: 50,
      failOnPage: 1,
      failMode: "hang",
      failTimes: Infinity,
    });
    // A long timeout, so nothing here can be the timeout firing.
    const driver = driverFor(fixture, { pageSize: 50, maxRetries: 3, timeoutMs: 30_000 });

    const controller = new AbortController();
    const pending = driver.listPrincipals({ signal: controller.signal });
    setTimeout(() => controller.abort(), 150);

    await expect(pending).rejects.toThrow(/cancelled/i);

    // EXACTLY ONE attempt at page 1. Three or four would mean the cancel was treated
    // as a retryable transport failure — the bug, and it would still "reject", so
    // the count is the only thing that distinguishes them.
    expect(fixture.userPages.filter((p) => p === 1)).toHaveLength(1);
  }, 60_000);
});

/**
 * #138, QA-1's baseline findings turned into fixtures.
 *
 * Both are cases where a test LOOKS like it covers the timeout and does not.
 */
describe("#138: what the timeout tests would otherwise miss (QA-1)", () => {
  test("the token timeout is not masked by memoisation — a fresh provider per case", async () => {
    // `_tenantAccessToken` caches on `_tokenExpiresAt`. A provider that already
    // fetched a token successfully never calls the endpoint again, so a hangToken
    // assertion made on a REUSED instance passes whether or not the token call is
    // bounded — the request under test is never made.
    //
    // This asserts the memo exists (one token call across two enumerations) and then
    // proves the bound holds on an instance that has NOT primed it. Both halves:
    // without the first, the second is just the hangToken test again.
    fixture = await startLarkFixture({ users: 10 });
    const warm = driverFor(fixture, { timeoutMs: 5_000 });
    await warm.listPrincipals();
    await warm.listGroups();
    const tokenCalls = fixture.requests.filter((r) =>
      r.path.endsWith("/auth/v3/tenant_access_token/internal")
    );
    expect(tokenCalls).toHaveLength(1);
    await fixture.close();

    // A COLD provider against a hung token endpoint: the memo cannot help it.
    fixture = await startLarkFixture({ users: 10, hangToken: true });
    const cold = driverFor(fixture, { timeoutMs: 150 });
    const started = Date.now();
    await expect(cold.listPrincipals()).rejects.toThrow(IdentityUnavailableError);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);

  test("the DRIVER's timeout wins when the caller's signal never fires", async () => {
    // The pairing for the caller-abort test. That one proves the caller can still
    // cancel — but it is green on unfixed code too, because passing the caller's
    // signal through is inherited behaviour. This is the half that is not: a caller
    // supplies a signal it never aborts, and the driver's own timeout must still end
    // the request. An implementation that forwards only the caller's signal hangs
    // here forever.
    fixture = await startLarkFixture({
      users: 100,
      pageSize: 50,
      failOnPage: 1,
      failMode: "hang",
      failTimes: Infinity,
    });
    const driver = driverFor(fixture, { pageSize: 50, maxRetries: 1, timeoutMs: 200 });

    // A real signal, never aborted.
    const controller = new AbortController();
    const started = Date.now();
    await expect(
      driver.listPrincipals({ signal: controller.signal })
    ).rejects.toThrow(IdentityUnavailableError);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(controller.signal.aborted).toBe(false);
  }, 60_000);
});
