// T-4b (#29) W-8 test helper.
//
// Once /v1 checks the grant half as well as the scope half, every HTTP suite that mocks
// `utils/prisma` also needs a policy store to answer against — otherwise a scope-only test
// fails for a reason it was never written to exercise.
//
// `grantingPrismaMock()` returns the mock shape those suites already build, plus the tables
// the grant check reads, answering "this principal holds the action". It is deliberately a
// PERMISSIVE store: these suites assert scope behaviour, and a store that denied would make
// every one of them pass for the wrong reason. The grant half has its own tests
// (__tests__/t4bGrantCheckHttp.test.js and security/authorization/*) which drive the engine
// explicitly rather than through this helper.

/**
 * @param {{createdBy?: number|null}} options creator attributed to any key looked up
 * @returns {Object} a `utils/prisma` mock that satisfies both scope and grant checks
 */
function grantingPrismaMock({ createdBy = 1 } = {}) {
  const allowRole = { role_id: 1 };
  return {
    $transaction: async (fn) => fn({ api_keys: { update: jest.fn() } }),
    workspaces: { findUnique: jest.fn() },
    api_keys: { findUnique: jest.fn().mockResolvedValue({ createdBy }) },
    workspace_users: { findMany: jest.fn().mockResolvedValue([]) },
    // S12 (#136): `keyGrantPrincipal` reads the key creator's row to refuse a
    // SUSPENDED one, and treats an unreadable users table as a denial. A mock
    // without this answers 403 for every keyed request — correct fail-closed
    // behaviour, but not what these suites are testing. Active by default; the
    // suspended and missing cases have their own tests.
    users: {
      count: jest.fn().mockResolvedValue(3),
      findUnique: jest.fn().mockResolvedValue({ suspended: 0 }),
    },
    // the engine's read path: known action -> granted role -> allow effect
    permissions: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) },
    principal_role_grants: { findMany: jest.fn().mockResolvedValue([allowRole]) },
    role_permissions: {
      findMany: jest.fn().mockResolvedValue([{ effect: "allow", role_id: 1 }]),
    },
  };
}

module.exports = { grantingPrismaMock };
