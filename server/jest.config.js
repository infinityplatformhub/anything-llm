// #73 — the reporter below fails a CI run in which a real-store suite did not execute.
//
// There was no jest config file before this; jest ran on its defaults. `testPathIgnorePatterns`
// restates the default plus the support directory, which holds helpers rather than suites and
// would otherwise be collected as a test file with no tests in it.
module.exports = {
  testEnvironment: "node",
  testPathIgnorePatterns: ["/node_modules/", "/__tests__/support/"],
  reporters: ["default", "<rootDir>/__tests__/support/realStoreReporter.js"],
};
