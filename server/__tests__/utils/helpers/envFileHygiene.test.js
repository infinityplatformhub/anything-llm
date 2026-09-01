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

  it("sets the mode explicitly rather than inheriting a permissive umask", () => {
    const previousUmask = process.umask(0o000);
    try {
      writeEnvFileAtomic(envPath, "OPEN_AI_KEY='sk-a'");
      expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(envPath).uid).toBe(process.getuid());
    } finally {
      process.umask(previousUmask);
    }
  });

  it("never lets a concurrent reader see an empty, partial, or loose-mode file", async () => {
    const body = `OPEN_AI_KEY='${"sk-".padEnd(4096, "x")}'`;
    writeEnvFileAtomic(envPath, body);

    let reads = 0;
    const bad = { empty: 0, partial: 0, loose: 0, missing: 0 };
    const deadline = Date.now() + 1500;
    const reader = (async () => {
      while (Date.now() < deadline) {
        try {
          const mode = fs.statSync(envPath).mode & 0o777;
          const seen = fs.readFileSync(envPath, "utf8");
          reads++;
          if (seen.length === 0) bad.empty++;
          else if (seen.length !== body.length) bad.partial++;
          if (mode !== 0o600) bad.loose++;
        } catch {
          bad.missing++;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    const writer = (async () => {
      while (Date.now() < deadline) {
        writeEnvFileAtomic(envPath, body);
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    await Promise.all([reader, writer]);

    expect(reads).toBeGreaterThan(100);
    expect(bad).toEqual({ empty: 0, partial: 0, loose: 0, missing: 0 });
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
    const realLstat = fs.lstatSync.bind(fs);
    const spy = jest.spyOn(fs, "lstatSync").mockImplementation((target) => {
      const stats = realLstat(target);
      if (target !== envPath) return stats;
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
        uid: process.getuid() + 1,
      });
    });
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(writeEnvFileAtomic(envPath, "OPEN_AI_KEY='sk-mine'")).toBe(false);
    spy.mockRestore();

    expect(fs.readFileSync(envPath, "utf8")).toBe("OPEN_AI_KEY='sk-planted'");
    expect(errors.mock.calls.flat().join(" ")).not.toContain("sk-mine");
    errors.mockRestore();
  });

  it("refuses a symlinked destination without touching what it points at", () => {
    const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-victim-"));
    const victim = path.join(victimDir, "victim.txt");
    fs.writeFileSync(victim, "ORIGINAL-CONTENT");
    fs.chmodSync(victim, 0o644);
    fs.symlinkSync(victim, envPath);
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(writeEnvFileAtomic(envPath, "OPEN_AI_KEY='sk-new'")).toBe(false);
    errors.mockRestore();

    expect(fs.readFileSync(victim, "utf8")).toBe("ORIGINAL-CONTENT");
    expect(fs.statSync(victim).mode & 0o777).toBe(0o644);
    expect(fs.lstatSync(envPath).isSymbolicLink()).toBe(true);
    fs.rmSync(victimDir, { recursive: true, force: true });
  });

  it("refuses a symlink that points at a path which does not exist yet", () => {
    const victim = path.join(tempDir, "not-created-yet.txt");
    fs.symlinkSync(victim, envPath);
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(writeEnvFileAtomic(envPath, "OPEN_AI_KEY='sk-new'")).toBe(false);
    errors.mockRestore();

    expect(fs.existsSync(victim)).toBe(false);
  });

  it("gives each write a temporary name no concurrent write can collide with", () => {
    const seen = new Set();
    const realOpen = fs.openSync.bind(fs);
    const spy = jest.spyOn(fs, "openSync").mockImplementation((target, ...rest) => {
      if (target !== envPath) seen.add(target);
      return realOpen(target, ...rest);
    });

    for (let i = 0; i < 50; i++) writeEnvFileAtomic(envPath, `OPEN_AI_KEY='sk-${i}'`);
    spy.mockRestore();

    expect(seen.size).toBe(50);
    expect(fs.readdirSync(tempDir)).toEqual([".env"]);
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
