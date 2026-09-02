# QA-2 evidence — #53 1fa7aeae — PASS 20/20 (154/154 suites, 1609 tests; 1 #57 flake)

Author: QA-2 (anything-llm-e6), transcribed by PMO.
1. migration/scope: org.member scope 'org' held by 4 org roles, no workspace role; CHECK rejects 'bogus'; org member = chat.send + org.member only.
2. 4 routes: member 200 / ungranted 403; removing org.member grant → 403 (gate reads it, not chat.send).
3. scope mismatch: org.member + workspace resource → throw (500 via requirePermission, not 403); workspace action + org resource → throw; added R5 ordering: impersonated + mis-shaped mutation → R5 deny, not throw (R5 lives in authorize(), evaluate() bypasses it by design — regression tests for R5 must call authorize()).
4. `:798` still chat.send; chat.send scope not 'org'. 5. my-capabilities 200 for member + super_admin, no org.member in payload.
Probe self-corrections: evaluate() is positional; R5 not reachable via evaluate().
