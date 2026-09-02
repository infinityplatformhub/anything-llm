# Recon flake: modelPricing/cacheIsolation.test.js "two instances with different directories do not overwrite each other" — ~1 in 5 on clean main
- Reported independently by Dev4 (#46 run) and dev-28 (post-#28 run, verified on detached clean main with their code absent). #38 fixed the etag flake in index.test.js; this is the NEW isolation test added by #38 itself.
- Cause (per dev-28): races on the unawaited background refresh started in the ModelPricing constructor; the test's second instance/dir observes a write from the first instance's in-flight refresh.
- Fix: test must await flushRefresh() for every instance it creates (or inject a no-network fetch) before asserting directory contents; consider making the constructor's background refresh awaitable via an exposed promise. Test-only expected.
- DoD: 20 consecutive full-suite runs 0 flake; RED = reproduce by forcing refresh latency.
