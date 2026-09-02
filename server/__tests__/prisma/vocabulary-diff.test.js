// T-1 vocabulary diff — P0-4 R3 contract: every scope string used by requireScope()
// at runtime must exist in the seeded permissions vocabulary. Walks LIVE SOURCE with
// Node fs + regex (no shell grep/sed nesting — QA-1 finding 4), so it enforces the
// contract regardless of which of P0-4 / T-1 merges first. A new scope without a
// seeded permission fails with the exact missing string.
//
// ponytail: assumes requireScope("...") takes a string literal; if P0-4 ever computes
// scopes dynamically, switch to importing its scope registry instead.

const fs = require("fs");
const path = require("path");
const { ALL_ACTIONS } = require("../../prisma/seeds/permissions");

const SERVER_DIR = path.join(__dirname, "../..");
const REQUIRE_SCOPE_RE = /requireScope\s*\(\s*(['"])([^'"]+)\1/g;

function liveScopesFromSource() {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const src = fs.readFileSync(full, "utf8");
      for (const m of src.matchAll(REQUIRE_SCOPE_RE)) found.add(m[2]);
    }
  };
  walk(SERVER_DIR);
  return [...found].sort();
}

describe("P0-4 scope strings and T-1 vocabulary are one namespace", () => {
  test("every live requireScope string is a seeded permission", () => {
    const missing = liveScopesFromSource().filter((s) => !ALL_ACTIONS.includes(s));
    expect(missing).toEqual([]);
  });

  test("seed vocabulary has no duplicate actions", () => {
    expect(new Set(ALL_ACTIONS).size).toBe(ALL_ACTIONS.length);
  });

  test("seed carries the PMO-approved API scope list in full", () => {
    // 39 approved API scopes (PMO 2026-09-02, +5 PR-4b(1), +1 PR-4b(2), +2 PR-4b(3), +3 PR-4b(4), +1 T-6) — subset of ALL_ACTIONS, single namespace per R3
    const approved = [
      "workspace.read", "workspace.write", "workspace.delete",
      "document.read", "document.write", "document.delete",
      "chat.read", "chat.write", "user.read", "user.write",
      "system.read", "system.write",
      "invite.read", "invite.create", "invite.delete",
      "embed.read", "embed.write", "embed.delete",
      "agent-flow.read", "agent-flow.write",
      "mcp-server.read", "mcp-server.write",
      "memory.read", "memory.write",
      "telegram.read", "telegram.write",
      "scheduled-job.read", "scheduled-job.write",
      "browser-extension.read", "browser-extension.write",
      "model-router.read", "model-router.write",
      // PR-4b(1)
      "workspace.create", "workspace.embeddings.manage",
      "thread.create", "thread.write", "thread.delete",
      // PR-4b(2)
      "document.folder.manage",
      // PR-4b(3)
      "embed.chat.read", "embed.create",
      // PR-4b(4)
      "system.env.read", "image.generate", "embedding.compute",
      // T-6 (#28)
      "audit.read",
      // #53: membership, carrying no authority
      "org.member",
      // #138: firing a directory run deactivates every user absent from the
      // provider snapshot, so it is its own action rather than a use of
      // user.manage, and super_admin holds it alone.
      "directory.sync",
    ];
    expect(approved.filter((a) => !ALL_ACTIONS.includes(a))).toEqual([]);
    expect(ALL_ACTIONS.length).toBe(63);
  });
});
