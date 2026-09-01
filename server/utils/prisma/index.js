const { PrismaClient } = require("@prisma/client");

// npx prisma introspect
// npx prisma generate
// npx prisma migrate dev --name init -> ensures that db is in sync with schema
// npx prisma migrate reset -> resets the db

const logLevels = ["error", "info", "warn"]; // add "query" to debug query logs
const prisma = new PrismaClient({
  log: logLevels,
  ...(process.env.NODE_ENV === "test" && process.env.DATABASE_URL
    ? { datasourceUrl: process.env.DATABASE_URL }
    : {}),
});

module.exports = prisma;
