# QA-1 evidence — #30 slice 2 78cdbecb — FAIL (confirms Techlead-2 BLOCKER-1)
Author: QA-1 (anything-llm-af), transcribed by PMO. Own worktree, DB qa1_s2b.
BLOCKER-1: carol (viewer of wsA only) → `authorizedPinnedDocs({workspace: wsB, user: carol})` returns wsB secret. Engine answers wsB/document.read allowed=false correctly; `DocumentManager.pinnedDocs` never reads `workspaceIds`/`orgWide` (0 matches) while the vector path does. Fix belongs in pinnedDocs, not the 10 call sites.
Banked: telegram path (actor param real, bridge reached, deny honoured, missing actor throws); baseline ACL/orphan/getContextFiles; grantDocumentAcl bumps version and deny applies immediately, raw prisma stays stale (expected); 10 call sites via bridge only.
Mutations: M3 dies (2), M8 dies (1), **M7 survives** — removing the systemActor early-return still passes because W1 has no parsed files; proven leaky by seeding alice's file → mutant returns it. Fix: seed a row before asserting systemActor → [].
Gate 1723/1760 (1 samlRoutesHttp socket flake).
