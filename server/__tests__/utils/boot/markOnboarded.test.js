const prisma = require("../../../utils/prisma");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");
const { SystemSettings } = require("../../../models/systemSettings");
const markOnboarded = require("../../../utils/boot/markOnboarded");

/**
 * O2b (#112) — the legacy onboarding backfill's guard row.
 *
 * The code predates this issue (utils/boot/markOnboarded.js, called from both
 * bootHTTP and bootSSL). What it did not have was coverage, so the behaviour
 * the O2 3b ruling asked for was correct BY READING — which is the state
 * `markOnboardingComplete` was in at #59, when it returned true for a write
 * that never happened.
 *
 * The three the ruling names: a legacy instance gets the row, an instance that
 * already has it is not written again, and a second call does nothing.
 */
const run = process.env.DATABASE_URL?.startsWith(PG_SCHEME) ? describe : describe.skip;

/**
 * The guard is "did it WRITE", and `lastUpdatedAt` cannot witness that: measured,
 * it does not move when the row is rewritten with the same value, so an
 * assertion on it stays green with the guard removed. Spy on the write instead.
 *
 * This is the mutation that caught it: deleting the `isOnboardingComplete()`
 * early return left all seven tests green, which is the self-satisfying shape
 * this project has already paid for twice.
 */
function watchWrites() {
  return jest.spyOn(SystemSettings, "markOnboardingComplete");
}

const LEGACY_ENV = ["LLM_PROVIDER", "VECTOR_DB", "AUTH_TOKEN", "JWT_SECRET"];

run("markOnboarded — the legacy backfill's guard row", () => {
  let saved;

  beforeEach(async () => {
    saved = Object.fromEntries(LEGACY_ENV.map((key) => [key, process.env[key]]));
    for (const key of LEGACY_ENV) delete process.env[key];
    await prisma.system_settings.deleteMany({
      where: { label: { in: ["onboarding_complete", "multi_user_mode"] } },
    });
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await prisma.system_settings.deleteMany({
      where: { label: { in: ["onboarding_complete", "multi_user_mode"] } },
    });
  });

  afterAll(() => prisma.$disconnect());

  const row = () =>
    prisma.system_settings.findUnique({ where: { label: "onboarding_complete" } });

  test("a legacy instance with no row gets one", async () => {
    // The condition the patch exists for: an install configured before the flag
    // existed. LLM_PROVIDER set is `isLegacyOnboarded`'s first signal.
    process.env.LLM_PROVIDER = "openai";
    expect(await row()).toBeNull();

    expect(await markOnboarded()).toBe(true);

    const written = await row();
    expect(written).not.toBeNull();
    expect(written.value).toBe("true");
    expect(await SystemSettings.isOnboardingComplete()).toBe(true);
  });

  test("a fresh instance with no legacy signal is left alone", async () => {
    // The other half of the guard, and the one that matters more: a genuinely
    // new install must still be offered onboarding. A backfill that fired here
    // would skip setup for everyone.
    expect(await markOnboarded()).toBe(false);
    expect(await row()).toBeNull();
    expect(await SystemSettings.isOnboardingComplete()).toBe(false);
  });

  test("an instance that already has the row is NOT written again", async () => {
    process.env.LLM_PROVIDER = "openai";
    await SystemSettings.markOnboardingComplete();
    expect(await row()).not.toBeNull();

    const write = watchWrites();
    try {
      // Returns undefined on the early-return path, not true: the guard is
      // "stop", not "report success".
      await markOnboarded();
      // The whole point of the guard row. Not a row comparison — the row looks
      // identical either way.
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
    expect((await row()).value).toBe("true");
  });

  test("running twice writes exactly once", async () => {
    process.env.LLM_PROVIDER = "openai";
    const write = watchWrites();
    try {
      // Both boot paths call it, and every restart calls it again. The second
      // call must be inert, not idempotent-by-luck.
      expect(await markOnboarded()).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);

      await markOnboarded();
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
    }
    expect((await row()).value).toBe("true");
  });

  test.each([
    ["VECTOR_DB", "pgvector"],
    ["AUTH_TOKEN", "some-single-user-password"],
    ["JWT_SECRET", "some-jwt-secret"],
  ])("treats %s as a legacy signal too", async (key, value) => {
    // Each arm of isLegacyOnboarded, so removing one is visible. Testing only
    // LLM_PROVIDER would let three quarters of the heuristic rot.
    process.env[key] = value;
    expect(await markOnboarded()).toBe(true);
    expect((await row()).value).toBe("true");
  });
});
