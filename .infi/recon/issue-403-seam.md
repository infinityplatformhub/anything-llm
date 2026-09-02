# requirePermission: 403 body shape inconsistent; frontend never checks res.ok

Source: QA-3 measurement + TL-2 ruling during #135 (2026-09-02).

## Server seam (lane: server/utils/middleware/requirePermission.js)
- Decision-denied path (:80) sends `{ error: "Forbidden." }` (JSON).
- Engine-throw path (:83) sends `sendStatus(403)` — EMPTY body. Same route refuses in two shapes depending on branch.
- AuthorizationContractError → `sendStatus(500)` (:92): a permission refusal raised inside a repository transaction surfaces as an empty 500.
- Open question (own review, information-disclosure): include the refused `action` in the body? Tells a caller which permission gates a route. Decide explicitly; do not fold into any route issue.

## Frontend (lane: frontend/src/models/admin.js, system.js)
- `deleteUser` (:42) and siblings do `.then(res => res.json())` with no `res.ok` check → any non-JSON refusal reaches the user as a browser JSON-parse message in the toast (pages/Admin/Users/UserRow/index.jsx:50).
- Fix: check status before parsing; map 403 to a permission message. Independent of the seam; do not wait on it.

## Contract
- Test: every requirePermission refusal path returns 403 with a JSON body; mutant flipping :83 to sendStatus → red.
- Frontend: unit test that a 403 with empty body yields a permission toast, not a parse error.
