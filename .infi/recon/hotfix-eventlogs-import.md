# Recon hotfix: EventLogs import dropped from server/endpoints/system.js (found by E2E #15 spec 09)
- Symptom: POST /api/system/event-logs → 500 `ReferenceError: EventLogs is not defined`; Settings → Event Logs page and clear-logs button broken for admins
- Cause: P0-6 sweep replaced write paths with emitAuditEvent and removed the import, but read/delete paths at system.js:1152 (whereWithData), :1155 (count), :1171 (delete) still call EventLogs directly
- Fix: restore `const { EventLogs } = require("../models/eventLogs");` in system.js (read/delete path stays on model; write path stays on emitAuditEvent per code-standards §2)
- DoD: HTTP-stack test (path /api/system/event-logs) admin → 200 with logs+total; clear → 200; RED first (currently 500). Grep all endpoints for `EventLogs.` without import = 0
- Type: hotfix
