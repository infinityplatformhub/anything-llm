/**
 * #70: settings writes report failures as return values, not exceptions. Every caller
 * must consume that value or it will claim success after the database rejected the write.
 *
 * This scans the runtime tree rather than naming today's callers, so a new bare await
 * turns the suite red without somebody remembering to extend a fixture list.
 */
const fs = require("fs");
const path = require("path");

const SERVER_ROOT = path.resolve(__dirname, "../..");
process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();
const CALL = /SystemSettings\.(?:_?updateSettings)\s*\(/g;

const sourceFiles = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["__tests__", "node_modules", "coverage"].includes(entry.name)) return [];
      return sourceFiles(fullPath);
    }
    return entry.name.endsWith(".js") ? [fullPath] : [];
  });

const matchingParen = (source, open) => {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")" && --depth === 0) return index;
  }
  throw new Error("Unclosed updateSettings call");
};

const ignoredCalls = () => {
  const ignored = [];
  for (const file of sourceFiles(SERVER_ROOT)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(CALL)) {
      const statementStart = source.lastIndexOf(";", match.index) + 1;
      const prefix = source.slice(statementStart, match.index);
      const assignment = prefix.match(/(?:const|let|var)\s+([\w$]+|\{[^}]+\})\s*=\s*await\s*$/s);
      let consumed = false;
      if (assignment) {
        const binding = assignment[1];
        if (binding.startsWith("{")) {
          consumed = /\b(?:success|error)\b/.test(binding);
        } else {
          const close = matchingParen(source, source.indexOf("(", match.index));
          const rest = source.slice(close + 1);
          consumed = new RegExp(`\\b${binding}\\b`).test(rest);
        }
      }
      if (!consumed) {
        ignored.push(`${path.relative(SERVER_ROOT, file)}:${source.slice(0, match.index).split("\n").length}`);
      }
    }
  }
  return ignored;
};

describe("settings update return-value sweep", () => {
  test("every SystemSettings settings write consumes its result", () => {
    expect(ignoredCalls()).toEqual([]);
  });
});

describe("agent plugin settings updates report the model result", () => {
  const { SystemSettings } = require("../../models/systemSettings");
  const plugins = [
    ["gmail", require("../../utils/agents/aibitat/plugins/gmail/lib").GmailBridge],
    [
      "google calendar",
      require("../../utils/agents/aibitat/plugins/google-calendar/lib")
        .GoogleCalendarBridge,
    ],
    [
      "outlook",
      require("../../utils/agents/aibitat/plugins/outlook/lib").OutlookBridge,
    ],
  ];

  beforeEach(() => jest.restoreAllMocks());

  test.each(plugins)("%s returns a failed settings write", async (_name, Bridge) => {
    jest.spyOn(SystemSettings, "updateSettings").mockResolvedValue({
      success: false,
      error: "system_settings unavailable",
    });

    await expect(Bridge.updateConfig({ deploymentId: "deployment" })).resolves.toEqual({
      success: false,
      error: "system_settings unavailable",
    });
  });

  test.each(plugins)("%s returns successful settings writes", async (_name, Bridge) => {
    jest
      .spyOn(SystemSettings, "updateSettings")
      .mockResolvedValue({ success: true, error: null });

    await expect(Bridge.updateConfig({ deploymentId: "deployment" })).resolves.toEqual({
      success: true,
    });
  });
});


describe("Outlook token persistence failures", () => {
  const { OutlookBridge } = require("../../utils/agents/aibitat/plugins/outlook/lib");

  beforeEach(() => jest.restoreAllMocks());

  test("token exchange reports a failed config persist", async () => {
    jest.spyOn(OutlookBridge, "getConfig").mockResolvedValue({
      clientId: "client",
      clientSecret: "secret",
      authType: "common",
    });
    jest.spyOn(OutlookBridge, "updateConfig").mockResolvedValue({
      success: false,
      error: "system_settings unavailable",
    });
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
      }),
    });

    await expect(
      new OutlookBridge().exchangeCodeForToken("code", "http://callback")
    ).resolves.toEqual({
      success: false,
      error: "system_settings unavailable",
    });
  });
});
