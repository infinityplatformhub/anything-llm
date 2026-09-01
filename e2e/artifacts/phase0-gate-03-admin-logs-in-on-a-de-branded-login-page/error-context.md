# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: phase0-gate.spec.js >> 03 admin logs in on a de-branded login page
- Location: tests/phase0-gate.spec.js:124:1

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
- textbox: e2eadmin
- text: Password
- textbox: E2eAdmin!2345
- button "Hold to show password":
  - img
- button "Login"
- button "Forgot password? Reset"
- heading "Recovery Codes" [level=3]:
  - img
  - text: Recovery Codes
- paragraph: In order to reset your password in the future, you will need these recovery codes. Download or copy your recovery codes to save them. These recovery codes are only shown once!
- list:
  - listitem: a8435f0b-bd76-46da-af27-161e43cfb515
  - listitem: 6b79d8cf-2b4e-4257-bcdb-cccb5401ac86
  - listitem: db5c75ac-d799-46c2-ad7b-e2216008372d
  - listitem: c24bc5aa-d172-48c7-a9e4-7279c3c4880b
- button "Download":
  - img
  - text: Download
```

# Test source

```ts
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
> 139 |   ).toBeVisible({ timeout: 30_000 });
      |     ^ Error: expect(locator).toBeVisible() failed
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
  169 |       ),
  170 |     },
  171 |     { timeout: 30_000 }
  172 |   );
  173 |   await expect(page.getByText(DOC_NAME).first()).toBeVisible({
  174 |     timeout: 90_000,
  175 |   });
  176 |   await expect
  177 |     .poll(
  178 |       async () => {
  179 |         const docs = await authedFetch(
  180 |           page,
  181 |           `/api/workspace/${WORKSPACE_SLUG}`
  182 |         );
  183 |         return (await docs.text()).includes(DOC_NAME);
  184 |       },
  185 |       { timeout: 120_000 }
  186 |     )
  187 |     .toBe(true);
  188 | });
  189 | 
  190 | test("06 chat answers with a citation pointing at the upload", async ({
  191 |   page,
  192 | }) => {
  193 |   await login(page, ADMIN);
  194 |   await page.goto(`/workspace/${WORKSPACE_SLUG}`);
  195 |   const prompt = page.locator("textarea").first();
  196 |   await prompt.waitFor({ state: "visible", timeout: 30_000 });
  197 |   await prompt.fill("What is the secret codeword?");
  198 |   await prompt.press("Enter");
  199 |   // Assert non-empty answer + citation naming the uploaded doc — never the
  200 |   // answer's content (mock LLM is canned anyway).
  201 |   await expect(
  202 |     page.locator("[class*='response'], .no-scroll, [data-toast]").last()
  203 |   ).toBeVisible({ timeout: 60_000 });
  204 |   await expect(page.getByText(DOC_NAME).first()).toBeVisible({
  205 |     timeout: 60_000,
  206 |   });
  207 | });
  208 | 
  209 | test("07 admin creates a member user via admin UI", async ({ page }) => {
  210 |   await login(page, ADMIN);
  211 |   await page.goto("/settings/users");
  212 |   await page.getByText("Add user").first().click();
  213 |   await page.locator('input[name="username"]').fill(MEMBER.username);
  214 |   await page.locator('input[name="password"]').fill(MEMBER.password);
  215 |   await page
  216 |     .locator('button:has-text("Create Account"), button:has-text("Save"), button:has-text("Add")')
  217 |     .last()
  218 |     .click();
  219 |   await expect(page.getByText(MEMBER.username).first()).toBeVisible({
  220 |     timeout: 30_000,
  221 |   });
  222 | });
  223 | 
  224 | test("08 admin creates an API key via admin UI", async ({ page }) => {
  225 |   await login(page, ADMIN);
  226 |   await page.goto("/settings/api-keys");
  227 |   await page
  228 |     .getByRole("button", { name: /generate|create|new api key/i })
  229 |     .click();
  230 |   await expect(page.getByText(/apw-key-/).first()).toBeVisible({
  231 |     timeout: 30_000,
  232 |   });
  233 | });
  234 | 
  235 | test("09 audit log shows the flow's events", async ({ page }) => {
  236 |   await login(page, ADMIN);
  237 |   await page.goto("/settings/event-logs");
  238 |   await expect(page.getByText(/login|multi.?user/i).first()).toBeVisible({
  239 |     timeout: 30_000,
```