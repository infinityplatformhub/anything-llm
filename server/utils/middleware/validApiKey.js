const { ApiKey } = require("../../models/apiKeys");
const { SystemSettings } = require("../../models/systemSettings");
const { emitAuditEvent } = require("../events");
const prisma = require("../prisma");
const { resolveActor } = require("../authorization/actorResolver");
const { DatabaseAuthorizationEngine } = require("../authorization/engine");

// T-4b (#29) W-8: PR-4a gave this middleware the SCOPE half of `/v1` authorization — does
// the key's scope string permit the action. Nothing asked the other half: does the
// principal behind the key actually HOLD a grant for it. Effective permission is
// grants(createdBy) ∩ scopes(key), so a key whose creator was demoted, or one minted with
// a scope its creator never held, passed anyway.
//
// The check lives here rather than in a router-level middleware because Express runs
// router `use()` in registration order and every /v1 route registers after the mount: a
// separate middleware could only run BEFORE apiKeyContext exists, forcing a second key
// lookup and leaving grant denials outside the `auth.key_used` audit event.
const WILDCARD_ACTION = "*";

/**
 * The grant half. Returns true when the action is permitted for the principal behind the
 * key, false otherwise — including when nothing can be resolved or the policy store is
 * unavailable, because "nothing objected" is not the same as "something approved".
 */
async function grantAllows(action, request, response, engine, addressed) {
  // Wildcard routes carry no action to evaluate. They are Dev1's burn-down list
  // (EXPECTED_WILDCARD_ROUTES) and keep scope-only behaviour until it reaches zero.
  if (action === WILDCARD_ACTION) return true;
  try {
    const actor = await resolveActor(request, response);
    if (!actor) return false;

    // W-9: authorize against the workspace the request ADDRESSES, not the key's binding.
    // The binding already gates inside the engine (`outside_key_binding`), so using it
    // here would only ever re-check what a bound key may reach and would leave an unbound
    // key authorized org-wide against a workspace it has no grant on.
    if (addressed === null) return false; // declared a workspace that does not resolve

    // A route that declares NO workspace (`/v1/workspaces`, `/v1/workspace/new`, the
    // document routes) is asking an org-level question: may this principal do this action
    // at all. The engine's binding gate denies any resource it cannot attribute to the
    // key's workspace, which is right for a workspace-bearing resource but would lock a
    // bound key out of these routes entirely — and they do their own narrowing (a bound
    // key's `/v1/workspaces` returns only its workspace; `boundKeyWorkspaceScope` covers
    // it). So the binding is not applied to this org-level question; every route that
    // names a workspace still carries it through, where QA-1's blocker lives.
    const ingressActor =
      addressed === undefined && actor.keyWorkspaceBinding?.length
        ? { ...actor, keyWorkspaceBinding: [] }
        : actor;

    const decision = await engine.authorize({
      actor: ingressActor,
      action,
      resource: { type: "api_route", id: null, orgId: actor.orgId ?? 1, workspaceId: addressed ?? null },
    });
    return decision.allowed === true;
  } catch (error) {
    console.error(`[authorization] grant check failed for ${action}: ${error.message}`);
    return false;
  }
}


/**
 * T-4b (#29) W-9 (G8): the workspace the request actually addresses.
 *
 * Resolved ONCE per request and shared by both checks below — the scope half compares it
 * to the key's binding, the grant half authorizes against it. Two lookups would also be
 * two chances for them to disagree.
 *
 * Returns undefined when the route declares no workspace (document routes have none by
 * design: attachment happens later) and null when a declared one does not resolve.
 */
async function addressedWorkspaceId(request, binding, db = prisma) {
  if (!binding) return undefined;
  if (binding.workspaceParam) {
    const raw = Number(request.params?.[binding.workspaceParam]);
    return Number.isInteger(raw) ? raw : null;
  }
  if (binding.workspaceSlugParam) {
    const workspace = await db.workspaces.findUnique({
      where: { slug: String(request.params?.[binding.workspaceSlugParam]) },
      select: { id: true },
    });
    return workspace ? Number(workspace.id) : null;
  }
  return undefined;
}

/**
 * The scope half's workspace check: a bound key reaches only the workspace it names.
 * @param {number|null|undefined} addressed resolved workspace id, from addressedWorkspaceId
 */
function workspaceBindingMatches(context, binding, addressed) {
  if (!context?.workspaceId || !binding) return true;
  if (addressed === null || addressed === undefined) return false;
  return context.workspaceId === String(addressed);
}

function validApiKey(action, binding = null) {
  if (typeof action !== "string" || !action) throw new Error("validApiKey requires an explicit scope");
  const engine = new DatabaseAuthorizationEngine();
  const middleware = async function apiKeyRequired(request, response, next) {
    response.locals.multiUserMode = await SystemSettings.isMultiUserMode();
    const bearerKey = request.header("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const apiKey = bearerKey ? await ApiKey.resolve(bearerKey) : null;
    if (!apiKey) return response.status(403).json({ error: "No valid api key found." });
    const context = {
      keyId: String(apiKey.id), keyPrefix: apiKey.keyPrefix, scopes: apiKey.scopes,
      workspaceId: apiKey.workspaceId ? String(apiKey.workspaceId) : null,
      expiresAt: apiKey.expiresAt, revokedAt: apiKey.revokedAt,
      // issue 45: this id belongs to `api_keys`. Stated rather than left to be inferred —
      // the resolver now refuses a context that does not say which credential table its id
      // came from, because two tables with independent id sequences mean a wrong guess
      // resolves to a real but unrelated row.
      keyKind: "api-key",
    };
    response.locals.apiKeyContext = context;
    const scopeAllowed = context.scopes.includes("*") || context.scopes.includes(action);
    // Resolved once and shared: the scope half compares it to the key's binding, the grant
    // half authorizes against it (W-9).
    const addressed = await addressedWorkspaceId(request, binding);
    const workspaceAllowed = workspaceBindingMatches(context, binding, addressed);
    const scopePassed = scopeAllowed && workspaceAllowed;
    // The scope half runs first, and a request that already failed it never reaches the
    // engine — it must not be able to make the policy store do work.
    const grantPassed = scopePassed
      ? await grantAllows(action, request, response, engine, addressed)
      : false;
    const allowed = scopePassed && grantPassed;
    // One event, not two: `auth.key_used` already carries `allowed`, so a grant denial is
    // recorded there with the half that rejected it. A separate event would leave the
    // original saying the key was used successfully while the caller saw a 403.
    const denyReason = allowed ? null : scopePassed ? "grant" : "scope";
    await prisma.$transaction(async (transaction) => {
      await transaction.api_keys.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } });
      await emitAuditEvent("auth.key_used", {
        scopedKeyId: context.keyId, keyPrefix: context.keyPrefix, action, allowed, denyReason, orgId: 1,
      }, null, { resource: { type: "api_key", id: context.keyId }, transaction });
    });
    // One message for both halves: which half rejected is audit detail, not something a
    // caller probing the API should be able to read off the response.
    if (!allowed) return response.status(403).json({ error: "Insufficient scope." });
    next();
  };
  middleware.isApiKeyGuard = true;
  middleware.scope = action;
  return middleware;
}

module.exports = { validApiKey, workspaceBindingMatches, addressedWorkspaceId };
