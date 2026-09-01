# Authorization engine seam

## Responsibility

Provide the only authorization decision point for routes, services, jobs, channels, connector scopes, and document/vector access. Return both decision and reason for diagnostics/audit; produce query-safe document ACL filters.

## Driver contract

```js
/** @typedef {{type:"user"|"service", id:string, orgId:string, workspaceIds:string[], groupIds:string[]}} Actor */
/** @typedef {{type:string, id:string|null, orgId:string, workspaceId:string|null, ownerId?:string, attributes?:Object}} Resource */
/** @typedef {{allowed:boolean, reason:string, matchedPolicyIds:string[]}} AuthorizationDecision */
/** @typedef {{orgId:string, actorId:string, groupIds:string[], workspaceIds:string[], allowedDocumentIds?:string[], deniedDocumentIds:string[], policyVersion:string}} DocumentAclFilter */
/** @interface AuthorizationEngineDriver */
class AuthorizationEngineDriver {
  /** @param {{actor:Actor, action:string, resource:Resource, context?:Object}} input @returns {Promise<AuthorizationDecision>} */
  async authorize(input) {}
  /** Throws AuthorizationDeniedError when denied. @returns {Promise<void>} */
  async assertAuthorized(input) {}
  /** @param {{actor:Actor, action:"document.read"|"document.search", orgId:string, workspaceIds?:string[]}} input @returns {Promise<DocumentAclFilter>} */
  async documentFilter(input) {}
  /** @param {{actor:Actor, action:string, resources:Resource[]}} input @returns {Promise<Map<string, AuthorizationDecision>>} */
  async authorizeMany(input) {}
}
module.exports = { AuthorizationEngineDriver };
```

Default deny applies to missing actor, unknown action/resource type, stale/unresolvable policy, and driver failure. `policyVersion` lets search prove which ACL snapshot it enforced.

## First driver

`DatabaseAuthorizationEngine`: Postgres-backed custom roles, workspace-local roles, document ACLs, group toggles, delegated admin duties, and admin privacy posture.

## Boundaries

- Driver MUST NOT infer permission from legacy `admin`/`manager` labels or grant global bypass.
- Driver MUST NOT fetch document contents, query vectors, mutate roles/ACLs, or emit user-visible responses.
- Callers MUST NOT post-filter unauthorized vector results; they pass `documentFilter()` into vector query.
- Background jobs and service accounts MUST supply explicit actors and cannot inherit creator permissions beyond granted scope.
- Cache keys MUST include actor, action, resource scope, and policy version; revocation must invalidate them.

## Failure semantics

Denied decisions are normal results; `assertAuthorized` maps them to `AuthorizationDeniedError` without leaking resource existence. Invalid inputs throw `AuthorizationContractError`. Store timeout/error throws `AuthorizationUnavailableError` and fails closed. `documentFilter` must never return an unfiltered fallback; empty access returns a valid match-none filter. Batch decisions preserve one result per requested resource or fail the whole call closed.
