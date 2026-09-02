const PG_SCHEME = "postgresql:";

function postgresUrl(value = process.env.DATABASE_URL) {
  if (!value?.startsWith(PG_SCHEME)) {
    throw new Error("DATABASE_URL must point to PostgreSQL");
  }
  return new URL(value);
}

/**
 * node-pg ignores `connection_limit` rather than erroring on it (measured), so
 * stripping it here is tidiness rather than necessity — but it stays stripped,
 * because a parameter that means nothing to this client should not travel with
 * a URL handed to it.
 */
function forPostgresClient(value) {
  const url = postgresUrl(value);
  url.searchParams.delete("schema");
  url.searchParams.delete("connection_limit");
  url.searchParams.delete("sslmode");
  return url.toString();
}

/**
 * #122: `connection_limit` is KEPT, and a default is supplied when the caller's
 * URL has none.
 *
 * It used to be deleted here, which would have made the pool cap work
 * everywhere EXCEPT the suites that route through this helper — the failure
 * mode being that the fix appears to work, because most suites build their URL
 * directly, while three quietly keep an uncapped 37-connection pool. A partial
 * fix that looks total is worse than no fix: nobody goes looking for the
 * remainder.
 *
 * The default is applied rather than required, so a suite that never set one
 * still gets a bounded pool.
 */
const DEFAULT_TEST_CONNECTION_LIMIT = "5";

function forPrismaTest(value, { schema } = {}) {
  const url = postgresUrl(value);
  url.searchParams.delete("sslmode");
  if (!url.searchParams.has("connection_limit"))
    url.searchParams.set("connection_limit", DEFAULT_TEST_CONNECTION_LIMIT);
  if (schema) url.searchParams.set("schema", schema);
  return url.toString();
}

function forPsql(value) {
  const url = postgresUrl(value);
  url.search = "";
  return url.toString();
}

module.exports = {
  PG_SCHEME,
  DEFAULT_TEST_CONNECTION_LIMIT,
  forPostgresClient,
  forPrismaTest,
  forPsql,
};
