/* eslint-env jest */

/**
 * Guards for how the .env file is written by dumpENV.
 *
 * Three properties, each independently attackable:
 *  - mode 0600, so another local account cannot read provider secrets
 *  - atomic replace, so a crash mid-write never leaves a truncated .env
 *  - owner check, so a planted file owned by someone else is not written into
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const { writeEnvFileAtomic } = require("../../../utils/helpers/updateENV");

let tempDir;
let envPath;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-hygiene-"));
  envPath = path.join(tempDir, ".env");
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("writeEnvFileAtomic", () => {
  it("creates the file readable and writable by the owner only", () => {
    expect(writeEnvFileAtomic(envPath, "OPEN_AI_KEY='sk-a'")).toBe(true);
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("tightens the mode of an already world-readable file", () => {
    fs.writeFileSync(envPath, "OPEN_AI_KEY='sk-old'", { mode: 0o644 });
    fs.chmodSync(envPath, 0o644);

    expect(writeEnvFileAtomic(envPath, "OPEN_AI_KEY='sk-new'")).toBe(true);
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(envPath, "utf8")).toBe("OPEN_AI_KEY='sk-new'");
  });

  it("never exposes a partially written file at the destination path", () => {
    fs.writeFileSync(envPath, "OPEN_AI_KEY='sk-old'");
    const realRename = fs.renameSync;
    let contentsAtRenameTime = null;
    const spy = jest
      .spyOn(fs, "renameSync")
      .mockImplementation((from, to) => {
        contentsAtRenameTime = fs.readFileSync(to, "utf8");
        return realRename(from, to);
      });

    writeEnvFileAtomic(envPath, "OPEN_AI_KEY='sk-new'");
    spy.mockRestore();

    expect(contentsAtRenameTime).toBe("OPEN_AI_KEY='sk-old'");
    expect(fs.readFileSync(envPath, "utf8")).toBe("OPEN_AI_KEY='sk-new'");
  });

  it("leaves no temporary file behind in the destination directory", () => {
    writeEnvFileAtomic(envPath, "OPEN_AI_KEY='sk-a'");
    expect(fs.readdirSync(tempDir)).toEqual([".env"]);
  });

  it("refuses to write a file owned by another account", () => {
    fs.writeFileSync(envPath, "OPEN_AI_KEY='sk-planted'");
    const realStat = fs.statSync;
    const spy = jest.spyOn(fs, "statSync").mockImplementation((target) => {
      const stats = realStat(target);
      if (target === envPath) return { ...stats, uid: process.getuid() + 1 };
      return stats;
    });
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(writeEnvFileAtomic(envPath, "OPEN_AI_KEY='sk-mine'")).toBe(false);
    spy.mockRestore();

    expect(fs.readFileSync(envPath, "utf8")).toBe("OPEN_AI_KEY='sk-planted'");
    expect(errors.mock.calls.flat().join(" ")).not.toContain("sk-mine");
    errors.mockRestore();
  });

  it("keeps the destination untouched when the write fails", () => {
    fs.writeFileSync(envPath, "OPEN_AI_KEY='sk-old'");
    const spy = jest.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw new Error("disk full");
    });

    expect(() => writeEnvFileAtomic(envPath, "OPEN_AI_KEY='sk-new'")).toThrow();
    spy.mockRestore();

    expect(fs.readFileSync(envPath, "utf8")).toBe("OPEN_AI_KEY='sk-old'");
    expect(fs.readdirSync(tempDir)).toEqual([".env"]);
  });
});
