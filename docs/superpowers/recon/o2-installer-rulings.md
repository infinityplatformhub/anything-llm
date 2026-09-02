# O2 installer — PMO rulings (2026-09-02, Dev5 recon)
- Q1 compose = happy path (<1h); external PG = preflight/doctor only; bare-metal out of scope.
- Q2 generated secrets written to the mounted `.env` (atomic 0600, only when absent); never CredentialStore.
- Q3 rotation/backup → O3; O2 prints a backup warning at generation.
- Q4 locale: warn hard, never block; compose adds `POSTGRES_INITDB_ARGS=--locale=en_US.UTF-8`.
- Q5 O2 must not require network; offline bundle → O1.
- Scope: secret generation, preflight (PG reachable, datctype UTF-8, CREATE EXTENSION rights, disk, port), wizard extends OnboardingFlow, `.env.required.example`.
- Mockup: 2 variants (wizard vs checklist), preflight 4 states, user-confirmed before task.sh start.
