# Recon: apiKeyContext.keyKind must be required (QA-2 T-4b #4, latent)
- Today actorResolver defaults an untagged apiKeyContext into the api_keys branch; validBrowserExtensionApiKey tags keyKind="browser-extension". A future ingress that forgets the tag silently inherits api_keys grants by id collision (the #33/T-4b cross-credential class).
- Change: apiKeyContext contract (PR-3 §6.1) gains required `keyKind: "api-key" | "browser-extension"`; validApiKey sets "api-key"; resolver throws AuthorizationContractError on missing/unknown keyKind (fail-closed, not default). Update seam 01/02 docs.
- RED: context without keyKind → ContractError (currently resolves); unknown value → ContractError; both ingress paths still resolve.
- Owner: Dev4 after #29/#32 (owns resolver + validApiKey.js). No migration.
