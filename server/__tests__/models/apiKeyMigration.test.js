const fs = require("fs");
const path = require("path");

test("forced-rotation migrations delete legacy rows and remove both plaintext columns", () => {
  const migrations = path.resolve(__dirname, "../../prisma/migrations");
  const api = fs.readFileSync(path.join(migrations, "20260902020000_key_hardening/migration.sql"), "utf8");
  const browser = fs.readFileSync(path.join(migrations, "20260902021000_browser_key_digest/migration.sql"), "utf8");
  expect(api).toMatch(/DELETE FROM "api_keys"/);
  expect(api).toMatch(/DROP COLUMN "secret"/);
  expect(browser).toMatch(/DELETE FROM "browser_extension_api_keys"/);
  expect(browser).toMatch(/DROP COLUMN "key"/);
  expect(api + browser).not.toMatch(/plaintext.*fallback|legacy.*lookup/i);
});

test("pepper is absent from schema seeds and migrations", () => {
  const files = [
    path.resolve(__dirname, "../../prisma/schema.prisma"),
    path.resolve(__dirname, "../../prisma/seed.js"),
    ...fs.readdirSync(path.resolve(__dirname, "../../prisma/migrations")).map((dir) => path.resolve(__dirname, "../../prisma/migrations", dir, "migration.sql")),
  ];
  expect(files.filter((file) => fs.existsSync(file)).filter((file) => fs.readFileSync(file, "utf8").includes("API_KEY_PEPPER"))).toEqual([]);
});
