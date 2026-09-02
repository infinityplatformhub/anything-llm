# TL-2 — #113 S4a — Lark Open API facts (docs-verified)

1. No delta/changes API. `page_token` is per-traversal pagination only (find_by_department, page_size max 50, 50/s, error 40012 on stale token). Events v3: contact.user/department created/updated/deleted — webhook push only, filtered by app scope (no event ≠ no change), `old_object` carries changed fields only, no replay. → full-enumerate reconcile is the source of truth; events are latency optimisation.
   https://open.larksuite.com/document/server-docs/contact-v3/user/find_by_department
   https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/resources
2. `union_id` stable across apps of the same developer within one tenant, differs across tenants, generated on first app enable. `user_id` stable across all apps in one tenant (scope contact:user.employee_id:readonly). Never key on `open_id`. Ruling: single-tenant → `user_id`.
   https://open.larksuite.com/document/server-docs/contact-v3/faq
   https://open.larksuite.com/document/home/user-identity-introduction/introduction
3. `email` and `enterprise_email` carry no verified semantics; `batch_get_id` does not resolve enterprise_email. Email match = trust in tenant admin; record as trust boundary; enterprise_email may be empty → predecided fallback.
   https://open.larksuite.com/document/server-docs/contact-v3/user/field-overview
