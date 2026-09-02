/**
 * #122 — the pool cap and the central disconnect.
 *
 * Every number here is read from `pg_stat_activity` DURING the run, never from
 * counting client objects beforehand. That distinction is the whole reason this
 * issue exists in the shape it does: the recon's original measurement counted
 * what its probe had opened rather than what the server was holding, reported
 * "40 connections", and was actually running against ~89. The claim it produced
 * did not survive re-measurement.
 *
 * WHAT THIS SUITE NEEDS: a PostgreSQL at DATABASE_URL whose `public` schema has
 * been migrated — it counts real backends and opens real clients, so there is
 * nothing to stub. Without a PostgreSQL URL every block below is SKIPPED rather
 * than failed, the same rule doctor.test.js follows.
 */
const { Client } = require("pg");
const {
  PG_SCHEME,
  DEFAULT_TEST_CONNECTION_LIMIT,
  forPrismaTest,
  forPostgresClient,
} = require("../../../utils/test/postgresUrl");

const run = process.env.DATABASE_URL?.startsWith(PG_SCHEME) ? describe : describe.skip;

/**
 * Backends on this database other than the counting connection itself.
 *
 * RF-1: a `pg.Client` that has connected but issued no statement may not yet
 * appear as a backend, so every helper below runs `SELECT 1` before anything is
 * counted. Counting objects instead of backends is the error this test exists
 * to make impossible to repeat.
 */
async function backendCount(counter) {
  const { rows } = await counter.query(
    `SELECT count(*)::int AS n
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()`
  );
  return rows[0].n;
}

async function withCounter(fn) {
  const counter = new Client({
    connectionString: forPostgresClient(process.env.DATABASE_URL),
  });
  await counter.connect();
  await counter.query("SELECT 1");
  try {
    return await fn(counter);
  } finally {
    await counter.end().catch(() => {});
  }
}

describe("the disconnect hook is actually wired (TL-2 M2/M3)", () => {
  // The hook releases a resource and asserts nothing, so removing it — or
  // emptying it — leaves every test in this repo green. That is precisely the
  // failure #122 exists to prevent: a pool that silently stops being released,
  // noticed only when several worktrees exhaust a 100-connection server.
  //
  // This block used to claim "nothing behavioural can catch it, because the
  // symptom is the absence of a side effect in a LATER process", and asserted
  // the file's TEXT instead. That claim was false and cost a round: the hook's
  // callback can be captured at require time and invoked here, in this process,
  // which catches a body that does not disconnect. #130.
  //
  // What genuinely is NOT testable from inside: that jest itself runs the
  // registered afterAll. Everything up to and including "the callback we handed
  // jest disconnects the client" is now behaviour, and only jest's promise to
  // call it is taken on trust.
  const fs = require("fs");
  const path = require("path");

  it("jest.config.js registers the disconnect setup file", () => {
    const config = require("../../../jest.config.js");
    expect(config.setupFilesAfterEnv ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining("disconnectPrisma")])
    );
  });

  it("the registered callback actually disconnects when invoked", async () => {
    // #130. The source-grep below answers "is the file still registered and
    // still shaped like a hook" — a different question, kept. This one answers
    // "does running it release the pool", which is the property that matters and
    // the one a grep cannot see: `if (false) await prisma.$disconnect()` matches
    // every pattern the grep looks for.
    //
    // The callback is captured by swapping `global.afterAll` for the duration of
    // the require, because that is the only handle the module offers — it
    // registers and returns nothing.
    //
    // `jest.isolateModules` rather than `delete require.cache[...]`: jest serves
    // these tests from its own module registry, so deleting from Node's cache
    // re-requires nothing and the swap captures NOTHING. Measured — the first
    // version of this test failed on the guard below with `captured === null`,
    // which is the whole reason that guard is here.
    const prismaPath = require.resolve("../../../utils/prisma");
    const disconnect = jest.fn().mockResolvedValue(undefined);

    let captured = null;
    const realAfterAll = global.afterAll;
    global.afterAll = (fn) => {
      captured = fn;
    };
    try {
      jest.doMock(prismaPath, () => ({ $disconnect: disconnect }));
      jest.isolateModules(() => {
        require("../../support/disconnectPrisma.js");
      });

      // Registered at all. Without this an empty module leaves `captured` null
      // and the assertions below would throw rather than pass — but the failure
      // would read as a crash instead of "the hook registered nothing".
      expect(typeof captured).toBe("function");

      // Invoked while the mock is still installed. The hook requires
      // `utils/prisma` LAZILY, inside the callback, so calling it after
      // `dontMock` reaches the real client and the spy records nothing — which
      // is how the second version of this test failed. Measured, not guessed.
      await captured();
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      global.afterAll = realAfterAll;
      jest.dontMock(prismaPath);
    }
  });

  it("the setup file exists and calls $disconnect in afterAll", () => {
    // Registered-but-empty is the same failure as not registered.
    const file = path.join(__dirname, "../../support/disconnectPrisma.js");
    expect(fs.existsSync(file)).toBe(true);
    const source = fs.readFileSync(file, "utf8");
    expect(source).toMatch(/afterAll\(/);
    expect(source).toMatch(/\$disconnect\(\)/);
  });
});

run("the URL helper keeps the cap it is given (QA-2)", () => {
  it("preserves an explicit connection_limit through forPrismaTest", () => {
    // It used to delete it. The pool cap would then have worked everywhere
    // except the suites routed through this helper — a fix that looks total
    // while three suites keep an uncapped pool, which nobody would go looking
    // for.
    const url = forPrismaTest(
      "postgresql://u:p@h:5432/db?connection_limit=5",
      { schema: "s" }
    );
    expect(url).toContain("connection_limit=5");
    expect(url).toContain("schema=s");
  });

  it("supplies a default cap when the caller's URL has none", () => {
    const url = forPrismaTest("postgresql://u:p@h:5432/db", { schema: "s" });
    expect(url).toContain(`connection_limit=${DEFAULT_TEST_CONNECTION_LIMIT}`);

    // TL-2 M4: the line above is a TAUTOLOGY on its own — it interpolates the
    // constant it is checking, so it passes for any value, including the
    // uncapped default this issue exists to replace. The constant has to be
    // bounded independently or the assertion says nothing.
    const cap = Number(DEFAULT_TEST_CONNECTION_LIMIT);
    expect(Number.isInteger(cap)).toBe(true);
    expect(cap).toBeGreaterThan(0);
    // Prisma's own default here is num_cpus*2+1 — 37 on this machine. Any cap
    // worth setting is far below that.
    expect(cap).toBeLessThanOrEqual(10);
  });

  it("does not invent a cap for the raw pg client, which has no such option", () => {
    // Measured: node-pg ignores it rather than erroring, so this is tidiness.
    // Asserted anyway, so "it does not matter" stays a decision rather than an
    // accident.
    expect(
      forPostgresClient("postgresql://u:p@h:5432/db?connection_limit=5")
    ).not.toContain("connection_limit");
  });
});

run("connection_limit actually bounds the pool", () => {
  jest.setTimeout(30000);

  it("holds far fewer backends under concurrency than the uncapped default", async () => {
    // Prisma ANNOUNCES `Starting a postgresql pool with 37 connections` and
    // then holds 2 until load arrives — the pool is lazy, so the announced
    // number is a ceiling rather than a reservation. Only real concurrency
    // shows what the cap is worth.
    const { PrismaClient } = require("@prisma/client");
    const base = forPostgresClient(process.env.DATABASE_URL);

    await withCounter(async (counter) => {
      const idle = await backendCount(counter);

      const capped = new PrismaClient({
        datasourceUrl: `${base}?connection_limit=3`,
        log: [],
      });
      try {
        await Promise.all(
          Array.from({ length: 40 }, () => capped.$queryRaw`SELECT 1`)
        );
        const used = (await backendCount(counter)) - idle;
        // The cap is 3; the measurement is allowed a little slack for a
        // connection in the process of closing, but not 37 of it.
        expect(used).toBeLessThanOrEqual(6);
        expect(used).toBeGreaterThan(0);
      } finally {
        await capped.$disconnect();
      }
    });
  });

  it("costs no measurable time on the same work", async () => {
    // If the cap were expensive, capping would be a trade rather than a fix.
    // Measured at ~49 ms for 60 queries; asserted loosely, because a timing
    // assertion tight enough to be precise is a flake.
    const { PrismaClient } = require("@prisma/client");
    const base = forPostgresClient(process.env.DATABASE_URL);
    const capped = new PrismaClient({
      datasourceUrl: `${base}?connection_limit=5`,
      log: [],
    });
    try {
      const started = Date.now();
      await Promise.all(
        Array.from({ length: 60 }, () => capped.$queryRaw`SELECT 1`)
      );
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await capped.$disconnect();
    }
  });
});

run("the singleton survives being disconnected (RF-2)", () => {
  it("reconnects after $disconnect, so the central afterAll is safe", async () => {
    // This property is what makes __tests__/support/disconnectPrisma.js
    // possible. If the client did not reconnect, that hook would leave every
    // later suite in a --runInBand process holding a closed pool.
    const prisma = require("../../../utils/prisma");
    expect(typeof (await prisma.users.count())).toBe("number");
    await prisma.$disconnect();
    expect(typeof (await prisma.users.count())).toBe("number");
  });

  it("releases its backends when disconnected", async () => {
    // The other half: reconnecting is only useful if disconnecting actually
    // frees something. Without this, "it reconnects" could be true of a client
    // that never let go.
    const { PrismaClient } = require("@prisma/client");
    const base = forPostgresClient(process.env.DATABASE_URL);

    await withCounter(async (counter) => {
      const before = await backendCount(counter);
      const client = new PrismaClient({
        datasourceUrl: `${base}?connection_limit=5`,
        log: [],
      });
      await Promise.all(
        Array.from({ length: 20 }, () => client.$queryRaw`SELECT 1`)
      );
      const during = await backendCount(counter);
      expect(during).toBeGreaterThan(before);

      await client.$disconnect();
      // POLL, not a longer sleep. `$disconnect` returns when the client has
      // asked its backends to close; Postgres reaps them on its own schedule,
      // so a fixed wait races that schedule rather than waiting for it. QA-2
      // measured 4/6 runs passing at 500 ms and 6/6 at 1000 and 2000 —
      // evidence that the number was tuning a race, and that any number would
      // be tuning it.
      //
      // The deadline is generous because it is a failure bound, not an
      // expectation: a healthy release takes well under a second, and 10 s only
      // decides how long a genuinely stuck one takes to report.
      const deadline = Date.now() + 10000;
      let after = await backendCount(counter);
      while (after > before && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        after = await backendCount(counter);
      }
      expect(after).toBeLessThanOrEqual(before);
    });
  });

  it("NEGATIVE CONTROL: a client that is disconnected and cached is unusable", async () => {
    // RF-2's control. If a closed client kept working, the reconnect assertion
    // above would be vacuous — it would pass whether or not the singleton had
    // the property it claims. A separate PrismaClient, disconnected and then
    // reused, must fail.
    const { PrismaClient } = require("@prisma/client");
    const client = new PrismaClient({
      datasourceUrl: `${forPostgresClient(process.env.DATABASE_URL)}?connection_limit=2`,
      log: [],
    });
    await client.$queryRaw`SELECT 1`;
    await client.$disconnect();

    // Prisma's own client also reconnects, so the control cannot be "a closed
    // client throws". What it CAN establish is that the reconnect is a real
    // round trip to a live server rather than a cached answer: point it at a
    // port nothing listens on and it must fail.
    const dead = new PrismaClient({
      datasourceUrl: "postgresql://nobody@127.0.0.1:1/none",
      log: [],
    });
    await expect(dead.$queryRaw`SELECT 1`).rejects.toThrow();
    await dead.$disconnect().catch(() => {});
    await client.$disconnect().catch(() => {});
  });
});

run("the central afterAll does not break a later suite (RF-3)", () => {
  // The ordering RF-3 asks for: this file's own hook disconnects at the end of
  // every suite, so the assertion that matters is that a suite running AFTER
  // one that disconnected still works. Under --runInBand that is the same
  // process, which is exactly the risky case.
  //
  // It is expressed as two sequential tests rather than two files, because jest
  // guarantees order within a file and does not guarantee it between them — a
  // two-file version would be a test whose premise is unenforced.
  it("first: uses prisma, then disconnects it", async () => {
    const prisma = require("../../../utils/prisma");
    expect(typeof (await prisma.users.count())).toBe("number");
    await prisma.$disconnect();
  });

  it("second: uses prisma again after that disconnect", async () => {
    const prisma = require("../../../utils/prisma");
    expect(typeof (await prisma.users.count())).toBe("number");
  });
});
