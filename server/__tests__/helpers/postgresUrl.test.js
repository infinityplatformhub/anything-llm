const { forPostgresClient, forPrismaTest, forPsql } = require("../../utils/test/postgresUrl");

const configured =
  "postgresql://user:pass@localhost:5432/app?schema=public&connection_limit=5&sslmode=prefer";

test("strips Prisma-only parameters for PostgreSQL clients", () => {
  expect(forPostgresClient(configured)).toBe(
    "postgresql://user:pass@localhost:5432/app"
  );
});

/**
 * #122 REVERSES this test's original expectation, and the reason it existed is
 * worth recording rather than overwriting.
 *
 * The cap used to be STRIPPED here because #21 measured three suites failing
 * with `connection_limit=5` present: t1-authz-migration (psql refusing the URI
 * query parameter), sqlite-to-pg-import (`db push` exceeding a 5s hook
 * timeout), and scheduler.postgres (PrismaClientInitializationError). That was
 * a real finding, not an oversight.
 *
 * What has changed since: `forPsql` now strips every query parameter, which was
 * the actual cause of the psql failure, and the hook timeouts were raised in
 * the same issue. Re-measured on this branch with the cap present, all three
 * pass — 14/14, 1/1, 3/3.
 *
 * So the strip was solving a problem that no longer exists, while silently
 * exempting the suites that route through this helper from the pool cap #122
 * applies everywhere else. A fix that works everywhere except three suites,
 * with nothing saying so, is the shape nobody goes looking for.
 */
test("keeps the pool cap when deriving an isolated Prisma schema", () => {
  expect(forPrismaTest(configured, { schema: "suite_42" })).toBe(
    "postgresql://user:pass@localhost:5432/app?schema=suite_42&connection_limit=5"
  );
});

test("strips all query parameters for psql", () => {
  expect(forPsql(configured)).toBe("postgresql://user:pass@localhost:5432/app");
});
