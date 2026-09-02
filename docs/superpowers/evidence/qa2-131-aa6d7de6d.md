# QA-2 — #131 `aa6d7de6d` — PASS (recorded by PMO from QA-2 message body; QA-2 is read-only)

Probe 104/104 (+group H); dev suites green. F2 closed: U+FE0F/FE00/3164/115F/FFA0/17B4 × 4 classes all gone; mechanism asserted (all DICP, none Cf, so the union is load-bearing). U+2800 stays OUT (printable So, no property). Group G (U+0600/200F/2067/206A/1D173) still green.

Mutations 5/5 (probe/dev): M1 remove strip 80/97; M2 Cf-only 17/17; M3 DICP-only 6/15; M4 keep-on-no-hit 3/3; M5 widen to \p{Mn} 2/1 — group H (Thai tone marks + id, Vietnamese + phone, fixture guard asserting \p{Mn} present, reverse: visible mark inside 13 digits must not match).

F1 (whole-string strip loses Thai joiners on hit) still pinned both ways; awaiting TL-2 ruling. F1 is scope (per-match), independent of H (class width).
