/**
 * #122 — one central `afterAll` that releases the Prisma pool.
 *
 * 28 of 55 authorization suites never disconnected, so each held its pool until
 * the worker process exited. Several worktrees running gates at once is how a
 * 100-connection server reaches `sorry, too many clients already`, which is
 * deterministic and unmistakable when it happens: every test in the run fails
 * with that message.
 *
 * A setup file rather than 28 edits — the next suite someone writes gets this
 * without having to remember, which is the difference between a fix and a
 * convention.
 *
 * SAFE TO RUN BETWEEN SUITES, measured rather than assumed: `utils/prisma`
 * exports one client per process and it RECONNECTS after `$disconnect` — a
 * query issued afterwards succeeds and the connection count goes back up. So a
 * later suite under `--runInBand`, which shares the process, is not left
 * holding a closed pool. That property is what makes this file possible, and it
 * is asserted in __tests__/utils/test/connectionBudget.test.js rather than
 * trusted.
 *
 * `require`d lazily inside the hook: a suite that mocks `utils/prisma`, or one
 * that never touches a database at all, should not have a real client
 * constructed on its behalf just so it can be disconnected.
 */
afterAll(async () => {
  try {
    const prisma = require("../../utils/prisma");
    if (typeof prisma?.$disconnect === "function") await prisma.$disconnect();
  } catch {
    // A suite that mocked the module, or one whose client was already closed,
    // must not fail here. This hook releases a resource; it does not assert
    // anything, and a throw would turn a green suite red for no defect.
  }
});
