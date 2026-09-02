// S4a (#113): Lark directory driver — the first directory-capable driver.
//
// This class ENUMERATES and NORMALIZES. It does not create users, deactivate
// anyone, decide membership or write a single row (seam 01 §Boundaries). The S4b
// reconciler owns all of that; a driver that "helpfully" wrote would put the
// authorization-relevant decisions in the place with the least review.
//
// THE RULE EVERYTHING BELOW SERVES. Lark has no delta API (recon §7.2): `page_token`
// paginates within one enumeration, and the change events are webhook-only,
// scope-filtered and unreplayable. So a full enumeration is the only source of truth,
// and the reconciler decides who has LEFT by looking at who is absent from it.
//
// That makes a partial result the most dangerous value this file can produce. A
// driver that catches a mid-enumeration failure and returns what it collected hands
// back a shorter directory, and the reconciler cannot tell that from an organisation
// where those people genuinely left. At 50 records per page — Lark's documented
// maximum — a 5,000-person org is 100 sequential requests, so this is an ordinary
// Tuesday, not a rare edge.
//
// Therefore: a failed enumeration THROWS. It never returns a short list. Every
// `catch` in this file either retries or rethrows; none of them return.

const {
  IdentityConfigurationError,
  IdentityUnavailableError,
  IdentityCapabilityError,
} = require("../errors");

const LARK_BASE_URL = "https://open.larksuite.com";
// Lark's documented maximum. Asking for more is rejected, and asking for less
// multiplies the number of requests a full sync needs.
const MAX_PAGE_SIZE = 50;
// Lark's documented rate limit is 50 requests/second; retries are for the 429 that
// arrives anyway (a shared tenant quota is not ours alone to spend).
const DEFAULT_MAX_RETRIES = 3;
// #138: every request is bounded. Matches `OidcIdentityProvider`'s
// DEFAULT_TIMEOUT_MS rather than introducing a second number — two identity
// providers disagreeing about how long "unreachable" takes is a difference nobody
// chose.
//
// Why a directory driver needs this and a login flow needs it less: a full sync runs
// as a background job holding a queue lease, and the lease is renewed by a heartbeat
// that only fires while the process makes progress. A fetch that never settles stops
// the heartbeat, the lease expires, and a SECOND worker claims the job and starts a
// concurrent apply against the same directory. The retry loop below does not save
// us — it handles a DROPPED socket, and a socket that stays open and never answers
// is not dropped.
const DEFAULT_TIMEOUT_MS = 10_000;
// #138: a 429 may advertise any `Retry-After`, and honouring it verbatim parks the
// run for that long — the same stalled-lease outcome as a hung socket, arriving
// through a header. Clamped rather than ignored: waiting IS the correct response to
// a shared tenant quota, and this only bounds how long.
const MAX_RETRY_AFTER_MS = 30_000;

class LarkIdentityProvider {
  static providerId() {
    return "lark";
  }

  /**
   * The first driver to declare directory capability.
   *
   * `deltaSync` is FALSE and that is a finding, not an omission: Lark has no delta
   * API. Declaring it would be the dishonest-capability case seam 01 forbids — core
   * reads these flags and would build a cursor-based sync on a cursor that does not
   * exist, then treat every unchanged record as missing.
   */
  static capabilities() {
    return {
      password: false,
      redirect: true,
      directorySync: true,
      groupSync: true,
      deltaSync: false,
    };
  }

  /**
   * @param {{appId:string, appSecret:string, baseUrl?:string, pageSize?:number,
   *          maxRetries?:number, fetchImpl?:Function, timeoutMs?:number}} config
   */
  constructor(config = {}) {
    const {
      appId,
      appSecret,
      baseUrl = LARK_BASE_URL,
      pageSize = MAX_PAGE_SIZE,
      maxRetries = DEFAULT_MAX_RETRIES,
      fetchImpl,
      timeoutMs,
    } = config;

    if (!appId || !appSecret) {
      throw new IdentityConfigurationError(
        "Lark provider requires an appId and appSecret."
      );
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw new IdentityConfigurationError(
        `Lark page size must be between 1 and ${MAX_PAGE_SIZE}.`
      );
    }

    this.className = "LarkIdentityProvider";
    this.appId = appId;
    this.appSecret = appSecret;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.pageSize = pageSize;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._fetch = fetchImpl ?? globalThis.fetch;
    this._token = null;
    this._tokenExpiresAt = 0;
  }

  /** The app secret must not reach a log, an error, or a serialized driver. */
  toJSON() {
    return {
      className: this.className,
      appId: this.appId,
      baseUrl: this.baseUrl,
      appSecret: "[redacted]",
    };
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return this.toJSON();
  }

  /**
   * The signal for one request: the caller's, the timeout, or both.
   *
   * COMBINED, never replaced. `signal: AbortSignal.timeout(ms)` is the plausible
   * one-liner and it silently removes the caller's ability to cancel — which the
   * sync job needs in order to stop on shutdown. `AbortSignal.any` aborts on
   * whichever fires first, which is what both parties mean.
   */
  _signalFor(callerSignal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  }

  async _tenantAccessToken(signal) {
    if (this._token && Date.now() < this._tokenExpiresAt) return this._token;

    const response = await this._fetch(
      `${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
        // #138: bounded like every other request. This one is easy to miss and the
        // most damaging to miss — it runs BEFORE any page is fetched, so a hung
        // token endpoint stalls the whole enumeration before it starts, and a
        // timeout on `_page` alone would look correct in review while failing
        // identically in production.
        signal: this._signalFor(signal),
      }
    ).catch((cause) => {
      throw new IdentityUnavailableError("Could not reach Lark.", { cause });
    });

    if (!response.ok) {
      throw new IdentityUnavailableError(
        `Lark refused a tenant token (HTTP ${response.status}).`
      );
    }
    const body = await response.json();
    if (body.code !== 0 || !body.tenant_access_token) {
      // The message is Lark's own; the secret is not in it and must not be added.
      throw new IdentityConfigurationError(
        `Lark rejected these app credentials: ${body.msg ?? `code ${body.code}`}`
      );
    }
    this._token = body.tenant_access_token;
    // Renew a minute early rather than at the boundary: a token that expires
    // mid-enumeration fails the whole run, which is correct but avoidable.
    this._tokenExpiresAt = Date.now() + Math.max(0, (body.expire ?? 7200) - 60) * 1000;
    return this._token;
  }

  /**
   * One page. Retries a 429 or a transport failure; NEVER returns a partial answer.
   *
   * @returns {Promise<{items:Array, nextToken:string|null}>}
   */
  async _page(pathname, cursor, signal) {
    const token = await this._tenantAccessToken(signal);
    const url = new URL(`${this.baseUrl}${pathname}`);
    url.searchParams.set("page_size", String(this.pageSize));
    if (cursor) url.searchParams.set("page_token", cursor);

    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response;
      try {
        response = await this._fetch(url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
          // A FRESH signal per attempt: `AbortSignal.timeout` starts counting when
          // it is created, so hoisting this out of the loop would give all four
          // attempts one shared deadline and the later retries no time at all.
          signal: this._signalFor(signal),
        });
      } catch (cause) {
        // #138: a CALLER'S abort is not retryable. Someone asked this to stop —
        // retrying it three more times ignores them, and on shutdown would keep the
        // process alive doing work that was cancelled. The request timeout IS
        // retryable, and both arrive as an abort, so they are told apart by whose
        // signal fired rather than by the error, which is identical for both.
        if (signal?.aborted) {
          throw new IdentityUnavailableError("Lark enumeration was cancelled.", {
            cause,
          });
        }
        // A dropped socket mid-enumeration is retryable, and is NOT an answer.
        // So is a timed-out one: a tenant that stops answering may answer the
        // retry, and the bound is what makes trying again safe.
        lastError = cause;
        await this._backoff(attempt);
        continue;
      }

      if (response.status === 429) {
        // Lark's own Retry-After when it sends one; our backoff otherwise. Waiting
        // is the point — hammering a shared tenant quota makes the next page fail too.
        const retryAfter = Number(response.headers.get("retry-after"));
        lastError = new Error("rate limited");
        // Clamped (#138). Honouring an arbitrary `Retry-After` verbatim parks the
        // run for as long as the header says — a day, if it says a day — which
        // stalls the job's lease exactly as a hung socket does. The wait itself is
        // correct and kept; only its ceiling is ours.
        await this._backoff(
          attempt,
          Number.isFinite(retryAfter)
            ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
            : null
        );
        continue;
      }

      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        await this._backoff(attempt);
        continue;
      }

      const body = await response.json();
      if (body.code !== 0) {
        lastError = new Error(body.msg ?? `code ${body.code}`);
        await this._backoff(attempt);
        continue;
      }

      const data = body.data ?? {};
      return {
        items: Array.isArray(data.items) ? data.items : [],
        // `has_more` decides, not the presence of a token: a final page that still
        // carries a token would otherwise loop forever.
        nextToken: data.has_more ? (data.page_token ?? null) : null,
      };
    }

    // Out of retries. THROW — the one thing this must never do is return the pages
    // it already has, because the reconciler would read the gap as departures.
    throw new IdentityUnavailableError(
      `Lark enumeration failed at ${pathname} after ${this.maxRetries + 1} attempts: ` +
        `${lastError?.message ?? "unknown error"}. No partial result is returned.`,
      { cause: lastError }
    );
  }

  async _backoff(attempt, explicitMs = null) {
    const ms = explicitMs ?? Math.min(2000, 100 * 2 ** attempt);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Every page, or an exception. Never a prefix.
   *
   * BOTH `delta` and `cursor` are refused, and for one reason: this driver's only
   * honest output is a COMPLETED FULL SNAPSHOT, because that is the only thing S4b
   * may act on absence from.
   *
   * `cursor` looks harmless — the seam offers it, and resuming mid-enumeration is a
   * reasonable thing for a paginated API. It is not harmless here. Measured on a
   * 250-user fixture at 5 per page:
   *
   *   listPrincipals({ cursor: "4" })
   *     → 235 principals, hasMore: false, nextCursor: null
   *
   * That is a PREFIX WEARING THE LABEL OF A COMPLETE SNAPSHOT. A reconciler reading
   * it deactivates the 15 people it skipped, and every field in the response says
   * the enumeration finished cleanly. Silently ignoring the argument would be worse
   * still: the caller believes it resumed and got a full answer instead.
   *
   * So a caller that wants to resume is told it cannot, in the same way it is told
   * there is no delta API.
   */
  async _enumerate(pathname, { cursor = null, delta = false, signal } = {}) {
    if (delta) {
      throw new IdentityCapabilityError(
        "Lark has no delta API (deltaSync: false). Enumerate in full."
      );
    }
    if (cursor != null) {
      throw new IdentityCapabilityError(
        "Lark enumeration cannot be resumed from a cursor: the result would be a " +
          "partial snapshot reported as a complete one, and absence from it is how " +
          "the reconciler decides who has left. Enumerate in full."
      );
    }
    const collected = [];
    let next = cursor;
    do {
      const page = await this._page(pathname, next, signal);
      collected.push(...page.items);
      next = page.nextToken;
    } while (next);
    return collected;
  }

  /**
   * @returns {Promise<{principals:Array<Object>, nextCursor:null, hasMore:false}>}
   */
  async listPrincipals(input = {}) {
    const rows = await this._enumerate("/open-apis/contact/v3/users", input);
    return {
      principals: rows.map((row) => this.constructor.toDirectoryPrincipal(row)),
      // A completed full snapshot, which is the only thing S4b may act on absence
      // from. There is no partial success to report.
      nextCursor: null,
      hasMore: false,
    };
  }

  async listGroups(input = {}) {
    const rows = await this._enumerate("/open-apis/contact/v3/departments", input);
    return {
      groups: rows.map((row) => this.constructor.toDirectoryGroup(row)),
      nextCursor: null,
      hasMore: false,
    };
  }

  /**
   * A Lark user row → DirectoryPrincipal.
   *
   * `user_id` is the subject (recon §7.2, PMO ruling). NOT `open_id`, which is
   * per-application: keying on it welds every identity_links row to one app
   * registration, and re-registering the app means re-linking every person. That is
   * unrecoverable once rows exist, which is why it is a permanent prohibition rather
   * than a preference. (If this ever goes multi-tenant the key becomes
   * `(tenant_key, union_id)` — a different SHAPE, not a different value, so every
   * row would have to be rewritten.)
   *
   * Address selection is `enterprise_email` → `email` → null. `enterprise_email` is
   * domain-verified at the tenant level and therefore the stronger claim, but it is
   * frequently empty. NEITHER field carries verified semantics in Lark — there is no
   * field meaning "this was proven" — so a principal with no address is returned with
   * `email: null` for the reconciler to quarantine. This driver does not decide that;
   * it reports what the directory said.
   */
  static toDirectoryPrincipal(row = {}) {
    const enterprise = String(row.enterprise_email ?? "").trim();
    const personal = String(row.email ?? "").trim();
    const subject = String(row.user_id ?? "").trim();

    // NIT-2. A row with no `user_id` would normalize to `subject: ""`, and TWO such
    // rows collide on the field that IS the identity — `identity_links` is unique on
    // `(provider, subject)`, so the second person would be refused as a duplicate of
    // the first, or worse, matched to their account.
    //
    // Refused rather than skipped, deliberately. Skipping is the quieter option and
    // the wrong one: a skipped principal is ABSENT from the snapshot, and absence is
    // exactly how the reconciler decides someone has left. A directory that returns
    // records this driver cannot key is a broken enumeration, not a smaller org, and
    // the seam already says invalid records are quarantined without widening
    // membership — this refuses the whole page rather than quietly narrowing it.
    if (!subject) {
      throw new IdentityUnavailableError(
        "Lark returned a directory record with no user_id. It cannot be keyed, and " +
          "dropping it would look to the reconciler like that person had left."
      );
    }

    return {
      provider: "lark",
      subject,
      email: enterprise || personal || null,
      // Reported, never asserted: Lark has no verified-email semantics, so claiming
      // `true` here would launder a directory record into a proven address. Core's
      // sync path applies the trust decision (recon §7.3); the driver states facts.
      emailVerified: false,
      active: row.status?.is_activated !== false,
      displayName: row.name ?? null,
      groupExternalIds: Array.isArray(row.department_ids)
        ? row.department_ids.map(String)
        : [],
      revision: null,
    };
  }

  static toDirectoryGroup(row = {}) {
    return {
      externalId: String(row.department_id ?? ""),
      name: row.name ?? null,
      // Lark does not return department membership on the department record; it is
      // carried on each user's `department_ids`. Empty here is honest — inventing a
      // list by cross-referencing would make this driver a reconciler.
      memberExternalIds: [],
      parentExternalId: row.parent_department_id ?? null,
      revision: null,
    };
  }

  // ---- login-shaped methods this slice does not implement -------------------
  // S4a is directory sync only. These exist so the shape matches the seam and a
  // caller gets a capability error rather than `undefined is not a function`.

  async beginLogin() {
    throw new IdentityCapabilityError(
      "Lark login is not part of S4a (directory sync only)."
    );
  }

  async completeLogin() {
    throw new IdentityCapabilityError(
      "Lark login is not part of S4a (directory sync only)."
    );
  }

  async refreshPrincipal() {
    throw new IdentityCapabilityError(
      "Refreshing a single principal is not implemented for Lark yet (V2 needs it)."
    );
  }

  /** Idempotent by contract; there is no remote session this driver created. */
  async revokeSession() {
    return;
  }
}

module.exports = { LarkIdentityProvider, MAX_PAGE_SIZE };
