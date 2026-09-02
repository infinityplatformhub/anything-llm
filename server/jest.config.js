// #73 — the reporter below fails a CI run in which a real-store suite did not execute.
//
// There was no jest config file before this; jest ran on its defaults. `testPathIgnorePatterns`
// restates the default plus the support directory, which holds helpers rather than suites and
// would otherwise be collected as a test file with no tests in it.
module.exports = {
  testEnvironment: "node",
  // #122: every suite releases the Prisma pool when it finishes. 28 of 55
  // authorization suites never did, holding their pool until the worker exited
  // — which is how several worktrees running gates at once exhaust a
  // 100-connection server. A setup file rather than 28 edits, so the next suite
  // written gets it without anyone remembering.
  setupFilesAfterEnv: ["<rootDir>/__tests__/support/disconnectPrisma.js"],
  testPathIgnorePatterns: ["/node_modules/", "/__tests__/support/"],
  reporters: ["default", "<rootDir>/__tests__/support/realStoreReporter.js"],
};
