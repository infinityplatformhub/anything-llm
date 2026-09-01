# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: phase0-gate.spec.js >> 08 admin creates an API key via admin UI
- Location: tests/phase0-gate.spec.js:224:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText(/apw-key-/).first()
Expected: visible
Timeout: 30000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 30000ms
  - waiting for getByText(/apw-key-/).first()

```

```yaml
- button "e2"
- link "Logo":
  - /url: /
  - img "Logo"
- text: Instance Settings
- link "AI Providers":
  - /url: /settings/api-keys
  - img
  - paragraph: AI Providers
- button:
  - img
- link "Admin":
  - /url: /settings/api-keys
  - img
  - paragraph: Admin
- button:
  - img
- link "Agent Agent Skills":
  - /url: /settings/agents
  - img "Agent"
  - paragraph: Agent Skills
- link "Community Hub Community Hub":
  - /url: /settings/api-keys
  - img "Community Hub"
  - paragraph: Community Hub
- button:
  - img
- link "Customization":
  - /url: /settings/api-keys
  - img
  - paragraph: Customization
- button:
  - img
- link "Tools":
  - /url: /settings/api-keys
  - img
  - paragraph: Tools
- button:
  - img
- link "Chat Embed":
  - /url: /settings/embed-chat-widgets
  - paragraph: Chat Embed
- link "Event Logs":
  - /url: /settings/event-logs
  - paragraph: Event Logs
- link "Developer API":
  - /url: /settings/api-keys
  - paragraph: Developer API
- link "System Prompt Variables":
  - /url: /settings/system-prompt-variables
  - paragraph: System Prompt Variables
- link "Browser Extension":
  - /url: /settings/browser-extension
  - paragraph: Browser Extension
- link "ApproofWorkspace Mobile":
  - /url: /settings/mobile-connections
  - paragraph: ApproofWorkspace Mobile
- link "Contact Support":
  - /url: https://github.com/infinityplatformhub/anything-llm/issues
- link "Privacy & Data":
  - /url: /settings/privacy
- link "v1.16.1":
  - /url: https://github.com/infinityplatformhub/anything-llm/releases/tag/v1.16.1
- link "Find us on GitHub":
  - /url: https://github.com/infinityplatformhub/anything-llm
  - img
- link "Docs":
  - /url: https://github.com/infinityplatformhub/anything-llm
  - img
- link "Join our Discord server":
  - /url: https://discord.com/invite/6UyHPeGZAC
  - img
- link "Home":
  - /url: /
  - img
- paragraph: API Keys
- paragraph: API keys allow the holder to programmatically access and manage this ApproofWorkspace instance.
- link "Read the API documentation →":
  - /url: /api/docs
- button "Generate New API Key":
  - img
  - text: Generate New API Key
- table:
  - rowgroup:
    - row "Name API Key Created By Created Actions":
      - columnheader "Name"
      - columnheader "API Key"
      - columnheader "Created By"
      - columnheader "Created"
      - columnheader "Actions"
  - rowgroup:
    - row "No API keys found":
      - cell "No API keys found"
- heading "Create new API key" [level=3]
- button "Close":
  - img
- text: Name
- textbox "Production integration"
- paragraph: Optional. Use a friendly name so you can identify this key later.
- paragraph: Once created the API key can be used to programmatically access and configure this ApproofWorkspace instance.
- link "Read the API documentation →":
  - /url: /api/docs
- button "Cancel"
- button "Create API Key"
```

# Test source

```ts
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
> 230 |   await expect(page.getByText(/apw-key-/).first()).toBeVisible({
      |                                                    ^ Error: expect(locator).toBeVisible() failed
  231 |     timeout: 30_000,
  232 |   });
  233 | });
  234 | 
  235 | test("09 audit log shows the flow's events", async ({ page }) => {
  236 |   await login(page, ADMIN);
  237 |   await page.goto("/settings/event-logs");
  238 |   await expect(page.getByText(/login|multi.?user/i).first()).toBeVisible({
  239 |     timeout: 30_000,
  240 |   });
  241 | });
  242 | 
  243 | test("10 member cannot see admin UI or hit admin routes", async ({ page }) => {
  244 |   await login(page, MEMBER);
  245 |   // No admin/settings entry in the sidebar for a default user.
  246 |   await expect(page.getByRole("link", { name: /settings/i })).toHaveCount(0);
  247 |   // Admin route denied through the same browser session.
  248 |   const res = await page.request.get("/api/system/env-dump");
  249 |   expect(res.status()).toBe(401);
  250 | });
  251 | 
  252 | test("11 restart resilience: data survives container restart", async ({
  253 |   request,
  254 |   page,
  255 | }) => {
  256 |   const { execSync } = require("child_process");
  257 |   execSync(`${UP_SCRIPT} restart-app`, { stdio: "ignore" });
  258 | 
  259 |   let ready = false;
  260 |   for (let i = 0; i < 90 && !ready; i++) {
  261 |     ready = (await request.get("/api/ping").catch(() => null))?.ok();
  262 |     if (!ready) await new Promise((r) => setTimeout(r, 1000));
  263 |   }
  264 |   expect(ready).toBe(true);
  265 | 
  266 |   // Same credentials from before the restart still work; workspace survives.
  267 |   await login(page, ADMIN);
  268 |   const ws = await authedFetch(page, `/api/workspace/${WORKSPACE_SLUG}`);
  269 |   expect(ws.status()).toBe(200);
  270 |   expect((await ws.text()).includes(DOC_NAME)).toBe(true);
  271 | });
  272 | 
  273 | test("12 logout returns to login", async ({ page }) => {
  274 |   await login(page, ADMIN);
  275 |   // Avatar menu (bottom-left) → last menu button clears the session.
  276 |   await page.getByText(ADMIN.username).first().click();
  277 |   await page.waitForTimeout(500);
  278 |   const menuButtons = page.locator("button:visible");
  279 |   const count = await menuButtons.count();
  280 |   await menuButtons.nth(count - 1).click();
  281 |   await expect(
  282 |     page.locator('button:has-text("Login")')
  283 |   ).toBeVisible({ timeout: 30_000 });
  284 | });
  285 | 
```