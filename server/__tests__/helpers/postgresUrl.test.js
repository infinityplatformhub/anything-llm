const { forPostgresClient, forPrismaTest, forPsql } = require("../../utils/test/postgresUrl");

const configured =
  "postgresql://user:pass@localhost:5432/app?schema=public&connection_limit=5&sslmode=prefer";

test("strips Prisma-only parameters for PostgreSQL clients", () => {
  expect(forPostgresClient(configured)).toBe(
    "postgresql://user:pass@localhost:5432/app"
  );
});

test("derives isolated Prisma schema without inheriting pool cap", () => {
  expect(forPrismaTest(configured, { schema: "suite_42" })).toBe(
    "postgresql://user:pass@localhost:5432/app?schema=suite_42"
  );
});

test("strips all query parameters for psql", () => {
  expect(forPsql(configured)).toBe("postgresql://user:pass@localhost:5432/app");
});
