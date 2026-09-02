# Techlead-1 — #149: `run-tests.yaml` vs `ci.yml`, and the lint-server ignore

**Skills invoked:** `superpowers:requesting-code-review`. `security-review` not applicable —
plain tier, CI configuration, no auth/permission/schema path. `infi-lessons` not invoked.

§7.14: no suite run. Source reads in the main checkout (read-only).

---

## Ruling: **(b) delete `run-tests.yaml` — with one thing checked first**

Dev5's lean is right and the measurement supports it: the workflow runs `yarn test` on a bare
runner with no `services:` and no job-level `env`, so it **cannot** pass — it is not a test that is
failing, it is a job that never had what it needs. Option (a) reproduces `ci.yml`'s postgres
service, five vector-store containers and its env block in a second file, and the first time one
drifts the two disagree about what "the suite passed" means. Two CI definitions for one suite is
the same class as two lock mechanisms or two implementations of user-removal: the one that is not
maintained becomes the one people trust.

**The thing to check before deleting, and it is a real difference, not a formality:**

```
run-tests.yaml   on: pull_request (ANY branch), paths: server/**.js, collector/**.js
ci.yml           on: pull_request, branches: ["approof/main"]
```

`run-tests.yaml` fires on **every** PR; `ci.yml` fires only on PRs targeting `approof/main`. So
deleting it removes backend CI from PRs that target any other branch — a stacked branch, or a
feature branch someone opens a PR against. On this program every merge goes to `approof/main`, so
the practical coverage loss is nil today; **but that is a property of current practice, not of the
configuration.** Either widen `ci.yml`'s `branches:` when deleting, or record explicitly that
backend CI runs only for PRs into `approof/main`. Deleting without doing one of those quietly
narrows what CI covers, which is the shape #146 just closed in the other direction.

Two smaller facts, both measured, that make the deletion cleaner than it looks:

- **The root `yarn test` covers nothing extra.** `jest.config.cjs` at the root ignores only `node_modules` and `open-computer`, and there are no root-level test files — the suite lives in `server/`, which is exactly what `ci.yml:159` runs with `working-directory: server`.
- **The collector has no tests at all** (`collector/package.json` has `lint`/`lint:check` and no `test` script), so `run-tests.yaml`'s `collector/**.js` path filter never triggered anything runnable.

So (b), and the deletion commit should say **why** — an upstream workflow that predates this fork's
CI and cannot pass in it — rather than just removing a file. A deleted workflow with no reason
recorded is the thing someone restores in six months.

## The lint-server ignore: **`globals.jest`, not an added ignore**

`eslint.config.mjs:9` ignores `__tests__/**` and not `__testHelpers__/**`, so the helpers hit
`jest is not defined`.

**Add the jest globals for `__testHelpers__/**`.** Ignoring it would exempt the helper files from
lint entirely — and they are ordinary source: `__testHelpers__/lark/server.js` is a real HTTP
server whose accept-then-silent behaviour #138's timeout tests depend on being correct. An
unlinted file that fixtures rely on is a worse trade than a two-line globals block, and the
existing `__tests__/**` ignore is itself the reason this was missed: the pattern that hides one
directory from lint hid the sibling too.

Worth one line in the config saying why the two directories are treated differently, since the
next person will otherwise "fix" the inconsistency by ignoring both.
