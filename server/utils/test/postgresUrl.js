function postgresUrl(value = process.env.DATABASE_URL) {
  if (!value?.startsWith("postgresql://")) {
    throw new Error("DATABASE_URL must point to PostgreSQL");
  }
  return new URL(value);
}

function forPostgresClient(value) {
  const url = postgresUrl(value);
  url.searchParams.delete("schema");
  url.searchParams.delete("connection_limit");
  url.searchParams.delete("sslmode");
  return url.toString();
}

function forPrismaTest(value, { schema } = {}) {
  const url = postgresUrl(value);
  url.searchParams.delete("connection_limit");
  url.searchParams.delete("sslmode");
  if (schema) url.searchParams.set("schema", schema);
  return url.toString();
}

function forPsql(value) {
  const url = postgresUrl(value);
  url.search = "";
  return url.toString();
}

module.exports = { forPostgresClient, forPrismaTest, forPsql };
