// S1 (#36) T2 — the five identity errors named by seam 01 §"Failure semantics".
// They are the contract between driver and core: core branches on WHICH error it
// caught (retry vs fail closed vs tell an admin), so a driver throwing a bare
// Error collapses three different outcomes into one.

const {
  IdentityConfigurationError,
  IdentityAuthenticationError,
  IdentityUnavailableError,
  IdentityConflictError,
  IdentityCapabilityError,
} = require("../../../utils/identityProviders/errors");

const ALL = [
  IdentityConfigurationError,
  IdentityAuthenticationError,
  IdentityUnavailableError,
  IdentityConflictError,
  IdentityCapabilityError,
];

describe("identity errors", () => {
  test("all five exist and are Error subclasses", () => {
    for (const Klass of ALL) {
      expect(typeof Klass).toBe("function");
      const instance = new Klass("boom");
      expect(instance).toBeInstanceOf(Error);
      expect(instance.message).toBe("boom");
    }
  });

  test("each carries its own name, so a log says which contract was broken", () => {
    const names = ALL.map((Klass) => new Klass("x").name);
    expect(names).toEqual([
      "IdentityConfigurationError",
      "IdentityAuthenticationError",
      "IdentityUnavailableError",
      "IdentityConflictError",
      "IdentityCapabilityError",
    ]);
    expect(new Set(names).size).toBe(ALL.length);
  });

  test("only IdentityUnavailableError is retryable", () => {
    // Seam §"Failure semantics": provider timeout is retryable; a linking
    // conflict is explicitly NOT ("requires admin resolution"). Retrying a
    // conflict re-runs a takeover attempt; retrying a bad signature is a loop.
    expect(new IdentityUnavailableError("timeout").retryable).toBe(true);
    expect(new IdentityConfigurationError("bad config").retryable).toBe(false);
    expect(new IdentityAuthenticationError("bad nonce").retryable).toBe(false);
    expect(new IdentityConflictError("already linked").retryable).toBe(false);
    expect(new IdentityCapabilityError("no directory sync").retryable).toBe(false);
  });

  test("a cause can be attached without leaking it into the message", () => {
    // The route returns a generic failure (seam: "without provider details"),
    // but the operator's log needs the real reason.
    const cause = new Error("JWKS 503");
    const error = new IdentityUnavailableError("Provider unavailable.", { cause });
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("Provider unavailable.");
  });

  test("instances are distinguishable by instanceof, not string matching", () => {
    const conflict = new IdentityConflictError("x");
    expect(conflict).toBeInstanceOf(IdentityConflictError);
    expect(conflict).not.toBeInstanceOf(IdentityAuthenticationError);
  });
});
