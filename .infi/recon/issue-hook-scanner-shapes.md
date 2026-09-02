# hookTimeouts guard scans one syntactic form; one untimed callback-style teardown drifted

Source: TL-2 6582558af + QA-2 quantification during #142 (2026-09-02).

## Measured (QA-2, server/__tests__)
| shape | files | scanned |
|---|---|---|
| afterAll(async () => …) | 88 | yes |
| afterAll((done) => …) | 2 | no |
| afterAll(function …) | 0 | — |
| afterEach(async …) | 9 | no |

Of the 11 unscanned, only ONE does slow external work without a timeout:
- `__tests__/endpoints/removeAndUnembedHttp.test.js:90` — `afterAll((done) => { server.closeAllConnections?.(); server.close(done); })`, no timeout arg.
- `t4aRouteIdor.test.js:86` same shape, already `}, 60_000)` — proves the fix is a one-line copy.
- deploymentShapeBoot / requestTokenShapeB: slow work is in scanned+timed async hooks; afterEach trivial. 4 remaining afterEach are `$disconnect` only.

## Scope
1. Fix: `}, 60_000)` on removeAndUnembedHttp.test.js:90 (1 line).
2. Extend `hookTimeouts.test.js` scanner to `afterAll((done) => …)`, `afterAll(function …)` and `afterEach(...)`; CONTROL sample must include one of each shape; mutant = remove the timeout from t4aRouteIdor:86 → red naming it.

## Lesson (§7.17)
A checker that enumerates ONE syntactic form silently exempts every other form, and the exemption is invisible because the check passes (same drift as #139 .nvmrc).

## Contract
`node ./node_modules/.bin/jest __tests__/utils/test/hookTimeouts.test.js __tests__/endpoints/removeAndUnembedHttp.test.js` → passed; offenders list empty across all four shapes.
