# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: phase0-gate.spec.js >> 11 restart resilience: data survives container restart
- Location: tests/phase0-gate.spec.js:252:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Page snapshot

```yaml
- generic [ref=f1e3]:
  - button "e2" [ref=f1e5] [cursor=pointer]
  - generic [ref=f1e6]:
    - generic [ref=f1e7]:
      - button "Hide Sidebar (⌘ + Shift + S)" [ref=f1e8] [cursor=pointer]
      - generic [ref=f1e11]:
        - link "Home" [ref=f1e14] [cursor=pointer]:
          - /url: /
          - img "Logo" [ref=f1e15]
        - generic [ref=f1e18]:
          - generic [ref=f1e20]:
            - generic [ref=f1e21]:
              - searchbox "Search" [ref=f1e23]
              - button [ref=f1e26] [cursor=pointer]
            - list "Workspaces" [ref=f1e29]:
              - listitem [ref=f1e30]:
                - link [ref=f1e32] [cursor=pointer]:
                  - /url: /workspace/e2e-gate-docs
                  - generic [ref=f1e33]:
                    - button [ref=f1e34]
                    - paragraph [ref=f1e39]: E2E Gate Docs
                    - generic [ref=f1e40]:
                      - button [ref=f1e41]
                      - button "General appearance settings" [ref=f1e44]
                - list "Threads" [ref=f1e47]:
                  - listitem [ref=f1e48]:
                    - link [ref=f1e53] [cursor=pointer]:
                      - /url: /workspace/e2e-gate-docs/t/edb885cd-db3b-4162-b931-450fd52759ed
                      - paragraph [ref=f1e54]: Thread
                  - listitem [ref=f1e56]:
                    - link [ref=f1e60] [cursor=pointer]:
                      - /url: /
                      - paragraph [ref=f1e61]: "*New Thread"
                  - button [ref=f1e62] [cursor=pointer]:
                    - paragraph [ref=f1e67]: New Thread
          - generic [ref=f1e70]:
            - link "Find us on GitHub" [ref=f1e72] [cursor=pointer]:
              - /url: https://github.com/infinityplatformhub/anything-llm
            - link "Docs" [ref=f1e76] [cursor=pointer]:
              - /url: https://github.com/infinityplatformhub/anything-llm
            - link "Join our Discord server" [ref=f1e80] [cursor=pointer]:
              - /url: https://discord.com/invite/6UyHPeGZAC
            - link "Settings" [ref=f1e84] [cursor=pointer]:
              - /url: /settings/interface
    - generic [ref=f1e87]:
      - button [ref=f1e89] [cursor=pointer]
      - generic [ref=f1e92]:
        - button "mock-llm" [ref=f1e94] [cursor=pointer]
        - generic [ref=f1e97]:
          - heading "How can I help you today?" [level=1] [ref=f1e98]
          - generic [ref=f1e103]:
            - textbox "Send a message" [active] [ref=f1e105]
            - generic [ref=f1e106]:
              - generic [ref=f1e107]:
                - button "Attach a file to this chat" [ref=f1e109] [cursor=pointer]
                - button "Tools" [ref=f1e111] [cursor=pointer]
              - generic [ref=f1e113]:
                - generic "Speak your prompt." [ref=f1e114] [cursor=pointer]
                - button "Send prompt message to workspace" [disabled] [ref=f1e115]
          - generic [ref=f1e117]:
            - button "Create an Agent" [ref=f1e118] [cursor=pointer]
            - button "Edit Workspace" [ref=f1e119] [cursor=pointer]
            - button "Upload a Document" [ref=f1e120] [cursor=pointer]
      - generic [ref=f1e123]:
        - paragraph [ref=f1e124]: Memories
        - button [ref=f1e125] [cursor=pointer]
```

# Test source

```ts
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
> 270 |   expect((await ws.text()).includes(DOC_NAME)).toBe(true);
      |                                                ^ Error: expect(received).toBe(expected) // Object.is equality
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