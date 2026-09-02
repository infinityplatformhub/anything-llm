# QA-3 evidence — #64 5d8bc8cb — PASS (second QA, product side)
Author: QA-3 (anything-llm-ea), transcribed by PMO. Fresh DB, supertest.
1. Minting with `chat.read` → 400 "Unknown scope(s): chat.read" — correct but unreadable (reads like a typo). Suggest RETIRED_SCOPES map with a pointer to chat.read_others. Controls: chat.read_others mints; editor mint refused at ceiling with a distinct message.
2. Legacy key holding chat.read: /v1 chat routes 403, /v1/workspaces 200, /v1/users 403 (control) — breaking change stays narrow.
3. #67 confirmed: bound-to-A key + super_admin creator → POST /v1/admin/workspace-chats 200 with workspace B secrets; per-workspace route 403. Org-wide routes have no addressedWorkspaceId.
Mutation: revert 3 scopes → 6/10 fail. Suite 17/17.
