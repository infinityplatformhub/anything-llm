# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: phase0-gate.spec.js >> 06 chat answers with a citation pointing at the upload
- Location: tests/phase0-gate.spec.js:190:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('e2e-citation-source.txt').first()
Expected: visible
Timeout: 60000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 60000ms
  - waiting for getByText('e2e-citation-source.txt').first()

```

```yaml
- button "e2"
- button "Hide Sidebar (⌘ + Shift + S)":
  - img
- link "Home":
  - /url: /
  - img "Logo"
- searchbox "Search"
- img
- button:
  - img
- list "Workspaces":
  - listitem:
    - link "E2E Gate Docs General appearance settings":
      - /url: /workspace/e2e-gate-docs
      - button:
        - img
      - paragraph: E2E Gate Docs
      - button:
        - img
      - button "General appearance settings":
        - img
    - list "Threads":
      - listitem:
        - link "Thread":
          - /url: /workspace/e2e-gate-docs/t/edb885cd-db3b-4162-b931-450fd52759ed
          - paragraph: Thread
      - button "New Thread":
        - img
        - paragraph: New Thread
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
- button "mock-llm"
- paragraph: What is the secret codeword?
- button "Copy":
  - img
- button "Agent complete Thoughts":
  - img "Agent complete"
  - text: Thoughts
  - img
- img
- text: Could not respond to message.
- paragraph: "The agent model failed to respond: Connection error."
- button "Agent complete Thoughts":
  - img "Agent complete"
  - text: Thoughts
  - img
- textbox "Send a message"
- button "Attach a file to this chat":
  - img
- button "Tools"
- img
- button "Send prompt message to workspace" [disabled]:
  - img
  - text: Send prompt message to workspace
- paragraph: Sources
- button:
  - img
- paragraph: Memories
- button:
  - img
```

# Test source

```ts
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
> 204 |   await expect(page.getByText(DOC_NAME).first()).toBeVisible({
      |                                                  ^ Error: expect(locator).toBeVisible() failed
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