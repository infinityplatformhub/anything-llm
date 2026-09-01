// Built-in service principals — the only Actor literals in the codebase.
//
// Hotfix #39: these used to live in actorResolver.js, which requires
// models/systemSettings, which reaches models/user, which requires
// legacyRoleGrants, which requires actorResolver. Whichever module in that cycle
// loads first hands the others a half-built exports object, and
// `SERVICE_PRINCIPALS.coreJobs` — evaluated as a default parameter, so at CALL
// time, not import time — threw "Cannot read properties of undefined". The
// caller caught and logged it, so a new workspace member simply never received
// their grant. Production survived only because index.js happens to load
// models/user first.
//
// This file requires NOTHING. It cannot participate in a cycle, so the constants
// are always fully formed no matter who loads first.

const SINGLE_USER_ACTOR = Object.freeze({
  type: "service",
  id: "single-user",
  orgId: 1,
});

const SERVICE_PRINCIPALS = Object.freeze({
  singleUser: SINGLE_USER_ACTOR,
  coreJobs: Object.freeze({ type: "service", id: "core-jobs", orgId: 1 }),
});

module.exports = { SINGLE_USER_ACTOR, SERVICE_PRINCIPALS };
