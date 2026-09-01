// One-shot generator: (re)writes the permissions INSERT block inside the T-1 migration
// from prisma/seeds/permissions.js. Run: node scripts/gen-vocabulary-sql.js <migration.sql>
const fs = require("fs");
const { ALL_ACTIONS } = require("../prisma/seeds/permissions");

const [file] = process.argv.slice(2);
if (!file) throw new Error("usage: node gen-vocabulary-sql.js <migration.sql>");
const src = fs.readFileSync(file, "utf8");
const cat = (a) => a.split(".")[0].replace(/-(.)/g, (_, c) => c.toUpperCase());
const desc = (a) => a.charAt(0).toUpperCase() + a.slice(1);
const q = (s) => `'` + s.replace(/'/g, `''`) + `'`;
const values = ALL_ACTIONS.map((a) => `  (${q(a)}, ${q(desc(a))}, ${q(cat(a))})`).join(",\n");
const re = /INSERT INTO "permissions" \("action", "description", "category"\) VALUES[\s\S]*?ON CONFLICT \("action"\) DO NOTHING;/;
if (!re.test(src)) throw new Error("permissions INSERT block not found");
fs.writeFileSync(file, src.replace(re, `INSERT INTO "permissions" ("action", "description", "category") VALUES\n${values}\nON CONFLICT ("action") DO NOTHING;`));
console.log("regenerated", ALL_ACTIONS.length, "actions");
