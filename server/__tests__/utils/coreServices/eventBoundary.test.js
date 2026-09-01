const fs = require("fs");
const path = require("path");

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(path.join(dir, entry.name)) : entry.name.endsWith(".js") ? [path.join(dir, entry.name)] : []);
}

test("only event subscriber mutates event_logs through any Prisma alias", () => {
  const server = path.resolve(__dirname, "../../..");
  const write = String.raw`(?:create|createMany|update|updateMany|upsert|delete|deleteMany)`;
  const offenders = files(server)
    .filter((file) => !file.includes("node_modules") && !file.endsWith(`${path.sep}utils${path.sep}events${path.sep}AuditEventSubscriber.js`) && !file.includes(`${path.sep}__tests__${path.sep}`))
    .filter((file) => {
      const source = fs.readFileSync(file, "utf8");
      const aliases = new Set(["event_logs"]);
      for (const match of source.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:\w+\.)?event_logs\b/g)) aliases.add(match[1]);
      for (const match of source.matchAll(/(?:const|let|var)\s*\{[^}]*event_logs\s*:\s*(\w+)[^}]*\}\s*=\s*\w+/g)) aliases.add(match[1]);
      return [...aliases].some((alias) => new RegExp(`(?:\\.|\\b)${alias}\\s*\\.\\s*${write}\\s*\\(`).test(source));
    });
  expect(offenders).toEqual([]);
});
