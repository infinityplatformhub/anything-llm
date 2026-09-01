# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: phase0-gate.spec.js >> 10 member cannot see admin UI or hit admin routes
- Location: tests/phase0-gate.spec.js:243:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText(/how can i help|send a message/i).first()
Expected: visible
Timeout: 30000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 30000ms
  - waiting for getByText(/how can i help|send a message/i).first()

```

```yaml
- img "Logo"
- heading "Welcome" [level=3]
- paragraph: Enter your username and password to access your ApproofWorkspace instance.
- text: Username
- textbox: e2emember
- text: Password
- textbox: E2eMember!2345
- button "Hold to show password":
  - img
- button "Login"
- button "Forgot password? Reset"
- heading "Recovery Codes" [level=3]:
  - img
  - text: Recovery Codes
- paragraph: In order to reset your password in the future, you will need these recovery codes. Download or copy your recovery codes to save them. These recovery codes are only shown once!
- list:
  - listitem: 1dc5280e-a394-4767-9528-734393a501d6
  - listitem: fc4ecb6b-c603-4b72-a9a9-b90d333bf5d2
  - listitem: 5bc855bc-c713-405e-8c90-47ea64ee5182
  - listitem: 20b6af6e-85fd-4fa2-81f6-3242d8ac3ef4
- button "Download":
  - img
  - text: Download
```

# Test source

```ts
  1   | const { test, expect } = require("@playwright/test");
  2   | 
  3   | /**
  4   |  * Phase 0 closing gate — one ordered flow over the real docker stack
  5   |  * (e2e/scripts/up.sh): onboarding → enable multi-user (product migration
  6   |  * path) → login → workspace → upload → chat+citation → admin user/key →
  7   |  * audit → multi-user negative → de-brand network check → restart.
  8   |  * workers=1 in playwright.config: each test depends on the previous state.
  9   |  *
  10  |  * Stack facts this suite is built on:
  11  |  * - e2e.env pre-configures generic-openai LLM+embedder against mock-llm, so
  12  |  *   the onboarding provider step is pre-filled and passing it completes
  13  |  *   onboarding (LLMPreference's forward posts onboarding_complete).
  14  |  * - With no AUTH_TOKEN, the instance boots single-user; the admin is created
  15  |  *   via POST /api/system/enable-multi-user (the Security page's own path).
  16  |  */
  17  | 
  18  | const path = require("path");
  19  | 
  20  | const ADMIN = { username: "e2eadmin", password: "E2eAdmin!2345" };
  21  | const MEMBER = { username: "e2emember", password: "E2eMember!2345" };
  22  | const DOC_NAME = "e2e-citation-source.txt";
  23  | const WORKSPACE_NAME = "E2E Gate Docs";
  24  | const UP_SCRIPT = path.resolve(__dirname, "../scripts/up.sh");
  25  | 
  26  | /** Login page has no <label> wiring — inputs are selected by name.
  27  |  * First login of a fresh admin shows a Recovery Codes modal (Download → Close). */
  28  | async function login(page, { username, password }) {
  29  |   await page.goto("/login");
  30  |   await page.locator('input[name="username"]').fill(username);
  31  |   await page.locator('input[name="password"]').fill(password);
  32  |   await page.locator('button:has-text("Login")').click();
  33  | 
  34  |   const recovery = page.getByRole("heading", { name: "Recovery Codes" });
  35  |   if (await recovery.isVisible({ timeout: 10_000 }).catch(() => false)) {
  36  |     const downloadBtn = page.getByRole("button", { name: /download/i });
  37  |     const dl = page.waitForEvent("download").catch(() => null);
  38  |     await downloadBtn.click();
  39  |     (await dl)?.cancel?.();
  40  |     await page.getByRole("button", { name: "Close" }).click();
  41  |   }
  42  | 
  43  |   await expect(
  44  |     page.getByText(/how can i help|send a message/i).first()
> 45  |   ).toBeVisible({ timeout: 30_000 });
      |     ^ Error: expect(locator).toBeVisible() failed
  46  | }
  47  | 
  48  | /** The SPA keeps its JWT in localStorage — page.request only carries cookies,
  49  |  * so authenticated API calls need the header injected. */
  50  | async function authedFetch(page, path, init = {}) {
  51  |   const token = await page.evaluate(() =>
  52  |     localStorage.getItem("approofworkspace_authToken")
  53  |   );
  54  |   return page.request.fetch(path, {
  55  |     ...init,
  56  |     headers: {
  57  |       ...(init.headers || {}),
  58  |       ...(token ? { Authorization: `Bearer ${token}` } : {}),
  59  |     },
  60  |   });
  61  | }
  62  | 
  63  | test("01 onboarding completes and lands in the app", async ({ page }) => {
  64  |   const outbound = [];
  65  |   page.on("request", (r) => outbound.push(new URL(r.url()).hostname));
  66  | 
  67  |   await page.goto("/onboarding");
  68  |   await expect(page.getByText(/get started/i)).toBeVisible({ timeout: 60_000 });
  69  | 
  70  |   // De-brand: no AnythingLLM anywhere, no posthog/anythingllm network calls.
  71  |   expect(await page.textContent("body")).not.toContain("AnythingLLM");
  72  |   expect(outbound.filter((h) => /posthog|anythingllm/i.test(h))).toHaveLength(
  73  |     0
  74  |   );
  75  | 
  76  |   // The home screen layers absolute background divs over the button — force
  77  |   // through them; the click target itself is correct.
  78  |   await page
  79  |     .getByRole("button", { name: /get started/i })
  80  |     .click({ force: true });
  81  |   // Providers are pre-configured via env; stepping forward through the LLM
  82  |   // screen completes onboarding (that step posts onboarding_complete).
  83  |   for (let step = 0; step < 6; step++) {
  84  |     const forward = page
  85  |       .locator(
  86  |         'button:has-text("Continue"), button:has-text("Next"), button:has-text("Finish"), button:has-text("Save"), button:has-text("Get Started")'
  87  |       )
  88  |       .last();
  89  |     if (!(await forward.isVisible().catch(() => false))) {
  90  |       const arrow = page
  91  |         .locator('[data-layout="onboarding"] button')
  92  |         .last(); // ArrowRight
  93  |       if (!(await arrow.isVisible().catch(() => false))) break;
  94  |       await arrow.click();
  95  |     } else {
  96  |       await forward.click();
  97  |     }
  98  |     await page.waitForTimeout(1_500);
  99  |     if (
  100 |       await page
  101 |         .getByText(/how can i help|send a message/i)
  102 |         .first()
  103 |         .isVisible()
  104 |         .catch(() => false)
  105 |     )
  106 |       break;
  107 |   }
  108 |   await expect(
  109 |     page.getByText(/how can i help|send a message/i).first()
  110 |   ).toBeVisible({ timeout: 60_000 });
  111 | });
  112 | 
  113 | test("02 enable multi-user mode (creates admin)", async ({ page }) => {
  114 |   // Single-user, no password: the app's own migration endpoint (the one the
  115 |   // Security settings page calls) creates the first admin.
  116 |   const res = await page.request.post("/api/system/enable-multi-user", {
  117 |     data: { username: ADMIN.username, password: ADMIN.password },
  118 |   });
  119 |   expect(res.ok()).toBe(true);
  120 | });
  121 | 
  122 | let WORKSPACE_SLUG = "e2e-gate-docs";
  123 | 
  124 | test("03 admin logs in on a de-branded login page", async ({ page }) => {
  125 |   const outbound = [];
  126 |   page.on("request", (r) => outbound.push(new URL(r.url()).hostname));
  127 |   await page.goto("/login");
  128 |   await expect(page.locator('button:has-text("Login")')).toBeVisible();
  129 |   expect(await page.textContent("body")).not.toContain("AnythingLLM");
  130 |   expect(outbound.filter((h) => /posthog|anythingllm/i.test(h))).toHaveLength(
  131 |     0
  132 |   );
  133 | 
  134 |   await page.locator('input[name="username"]').fill(ADMIN.username);
  135 |   await page.locator('input[name="password"]').fill(ADMIN.password);
  136 |   await page.locator('button:has-text("Login")').click();
  137 |   await expect(
  138 |     page.getByText(/how can i help|send a message/i).first()
  139 |   ).toBeVisible({ timeout: 30_000 });
  140 | });
  141 | 
  142 | test("04 create workspace", async ({ page }) => {
  143 |   await login(page, ADMIN);
  144 |   const res = await authedFetch(page, "/api/workspace/new", {
  145 |     method: "POST",
```