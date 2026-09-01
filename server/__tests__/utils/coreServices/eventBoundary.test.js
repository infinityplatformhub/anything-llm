const fs = require("fs");
const path = require("path");

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(path.join(dir, entry.name)) : entry.name.endsWith(".js") ? [path.join(dir, entry.name)] : []);
}

test("only event subscriber writes event_logs", () => {
  const server = path.resolve(__dirname, "../../..");
  const offenders = files(server).filter((file) => !file.includes("node_modules") && !file.includes(`${path.sep}utils${path.sep}events${path.sep}`) && !file.includes(`${path.sep}__tests__${path.sep}`)).filter((file) => /prisma\.event_logs\.(create|update)/.test(fs.readFileSync(file, "utf8")));
  expect(offenders).toEqual([]);
});
