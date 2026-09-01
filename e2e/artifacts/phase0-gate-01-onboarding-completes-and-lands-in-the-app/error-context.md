# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: phase0-gate.spec.js >> 01 onboarding completes and lands in the app
- Location: tests/phase0-gate.spec.js:63:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText(/get started/i)
Expected: visible
Timeout: 60000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 60000ms
  - waiting for getByText(/get started/i)

```

```yaml
- button "Hide Sidebar (⌘ + Shift + S)":
  - img
- link "Home":
  - /url: /
  - img "Logo"
- searchbox "Search"
- img
- button:
  - img
- list "Workspaces"
- link "Find us on GitHub":
  - /url: https://github.com/infinityplatformhub/anything-llm
  - img
- link "Docs":
  - /url: https://github.com/infinityplatformhub/anything-llm
  - img
- link "Join our Discord server":
  - /url: https://discord.com/invite/6UyHPeGZAC
  - img
- link "Settings":
  - /url: /settings/interface
  - img
- button:
  - img
- heading "How can I help you today?" [level=1]
- textbox "Send a message"
- button "Attach a file to this chat":
  - img
- button "Start Agent Session":
  - img
- button "Tools"
- img
- button "Send prompt message to workspace" [disabled]:
  - img
  - text: Send prompt message to workspace
- button "Create an Agent"
- button "Upload a Document"
- paragraph: Memories
- button:
  - img
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
  45  |   ).toBeVisible({ timeout: 30_000 });
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
> 68  |   await expect(page.getByText(/get started/i)).toBeVisible({ timeout: 60_000 });
      |                                                ^ Error: expect(locator).toBeVisible() failed
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
  146 |     data: { name: WORKSPACE_NAME },
  147 |   });
  148 |   expect(res.status()).toBe(200);
  149 |   const { workspace } = await res.json();
  150 |   WORKSPACE_SLUG = workspace.slug;
  151 |   await page.goto(`/workspace/${WORKSPACE_SLUG}`);
  152 |   await expect(
  153 |     page.getByText(/how can i help|send a message/i).first()
  154 |   ).toBeVisible({ timeout: 30_000 });
  155 | });
  156 | 
  157 | test("05 upload a small .txt document and wait for embedding", async ({
  158 |   page,
  159 | }) => {
  160 |   await login(page, ADMIN);
  161 |   await page.goto(`/workspace/${WORKSPACE_SLUG}/settings/documents`);
  162 |   await page.setInputFiles(
  163 |     'input[type="file"]',
  164 |     {
  165 |       name: DOC_NAME,
  166 |       mimeType: "text/plain",
  167 |       buffer: Buffer.from(
  168 |         "The secret codeword for the E2E gate is fortytwo. This document exists to be cited."
```