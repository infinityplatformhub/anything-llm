/**
 * P0-4 PR-0 security hotfix (issue #8).
 *
 * `GET /v1/users/:id/issue-auth-token` lets ANY valid API key mint a temporary
 * auth token for ANY user — including admins — which exchanges for a real
 * session JWT at `/request-token/sso/simple`. Until API keys carry scopes
 * (P0-4 PR-3..PR-5), that is full admin impersonation from any key.
 *
 * This middleware closes the endpoint by default. It reopens only when the
 * operator explicitly sets SIMPLE_SSO_ISSUE_UNSAFE_ALLOW to a non-empty value,
 * accepting the impersonation risk. The flag and this middleware are removed
 * by PR-5 (sso.issue scope enforcement).
 * @param {import("express").Request} _
 * @param {import("express").Response} response
 * @param {import("express").NextFunction} next
 * @returns {void}
 */
function ssoIssuanceLock(_, response, next) {
  if (!process.env.SIMPLE_SSO_ISSUE_UNSAFE_ALLOW) {
    return response.status(403).json({
      error:
        "Temporary auth token issuance is disabled pending the API key scope rollout. See release notes.",
    });
  }
  console.warn(
    "[ssoIssuanceLock] SIMPLE_SSO_ISSUE_UNSAFE_ALLOW is set: any valid API key can impersonate any user via issue-auth-token. Remove this flag once scoped keys (P0-4 PR-5) ship."
  );
  next();
}

module.exports = { ssoIssuanceLock };
