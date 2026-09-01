const { test, expect } = require("@playwright/test");

/**
 * Phase 0 closing gate — one ordered flow over the real docker stack
 * (e2e/scripts/up.sh): onboarding → enable multi-user (product migration
 * path) → login → workspace → upload → chat+citation → admin user/key →
 * audit → multi-user negative → de-brand network check → restart.
 * workers=1 in playwright.config: each test depends on the previous state.
 *
 * Stack facts this suite is built on:
 * - e2e.env pre-configures generic-openai LLM+embedder against mock-llm, so
 *   the onboarding provider step is pre-filled and passing it completes
 *   onboarding (LLMPreference's forward posts onboarding_complete).
 * - With no AUTH_TOKEN, the instance boots single-user; the admin is created
 *   via POST /api/system/enable-multi-user (the Security page's own path).
 */

const path = require("path");

const ADMIN = { username: "e2eadmin", password: "E2eAdmin!2345" };
const MEMBER = { username: "e2emember", password: "E2eMember!2345" };
const DOC_NAME = "e2e-citation-source.txt";
const WORKSPACE_NAME = "E2E Gate Docs";
const UP_SCRIPT = path.resolve(__dirname, "../scripts/up.sh");

/** Login page has no <label> wiring — inputs are selected by name.
 * First login of a fresh admin shows a Recovery Codes modal (Download → Close). */
async function login(page, { username, password }) {
  await page.goto("/login");
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button:has-text("Login")').click();

  const recovery = page.getByRole("heading", { name: "Recovery Codes" });
  if (await recovery.isVisible({ timeout: 10_000 }).catch(() => false)) {
    const downloadBtn = page.getByRole("button", { name: /download/i });
    const dl = page.waitForEvent("download").catch(() => null);
    await downloadBtn.click();
    (await dl)?.cancel?.();
    await page.getByRole("button", { name: "Close" }).click();
  }

  await expect(
    page.getByText(/how can i help|send a message/i).first()
  ).toBeVisible({ timeout: 30_000 });
}

/** The SPA keeps its JWT in localStorage — page.request only carries cookies,
 * so authenticated API calls need the header injected. */
async function authedFetch(page, path, init = {}) {
  const token = await page.evaluate(() =>
    localStorage.getItem("approofworkspace_authToken")
  );
  return page.request.fetch(path, {
    ...init,
    headers: {
      ...(init.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

test("01 onboarding wizard completes and lands in the app", async ({ page }) => {
  const outbound = [];
  page.on("request", (r) => outbound.push(new URL(r.url()).hostname));

  await page.goto("/onboarding");
  await expect(page.getByText(/get started/i)).toBeVisible({ timeout: 60_000 });

  // De-brand: no AnythingLLM anywhere, no posthog/anythingllm network calls.
  expect(await page.textContent("body")).not.toContain("AnythingLLM");
  expect(outbound.filter((h) => /posthog|anythingllm/i.test(h))).toHaveLength(
    0
  );

  // Home screen layers background divs over the button; the target is right.
  await page
    .getByRole("button", { name: /get started/i })
    .click({ force: true });
  await page.waitForURL(/llm-preference/, { timeout: 30_000 });

  // LLM preference: Generic OpenAI → mock provider.
  await page
    .locator('[role="button"], div, label')
    .filter({ hasText: /^Generic OpenAI$/ })
    .first()
    .click();
  await page.locator('input[name="GenericOpenAiBasePath"]').fill("http://mock-llm:8080/v1");
  await page.locator('input[name="GenericOpenAiKey"]').fill("e2e-mock-key");
  await page.locator('input[name="GenericOpenAiModelPref"]').fill("mock-llm");
  await forward(page);

  // Embedder preference (same provider family).
  await expect(page.locator('input[name="EmbeddingBasePath"]')).toBeVisible({
    timeout: 30_000,
  });
  await page.locator('[role="button"], div, label')
    .filter({ hasText: /^Generic OpenAI$/ })
    .first()
    .click({ force: true });
  await page.locator('input[name="EmbeddingBasePath"]').fill("http://mock-llm:8080/v1");
  await page.locator('input[name="EmbeddingModelPref"]').fill("mock-embed");
  await page.locator('input[name="GenericOpenAiEmbeddingApiKey"]').fill("e2e-mock-key");
  await forward(page);

  // User setup: My team → admin account.
  await expect(page.getByText(/how many users/i)).toBeVisible({
    timeout: 30_000,
  });
  await page.getByText("My team").click();
  await page.waitForTimeout(500);
  await page.locator('input[name="username"]').fill(ADMIN.username);
  await page.locator('input[name="password"]').fill(ADMIN.password);
  await forward(page);

  // Data handling + survey: advance to the app.
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(1_500);
    if (
      await page
        .getByText(/how can i help|send a message/i)
        .first()
        .isVisible()
        .catch(() => false)
    )
      break;
    await forward(page);
  }

  await expect(
    page.getByText(/how can i help|send a message/i).first()
  ).toBeVisible({ timeout: 60_000 });
});

/** Steps advance via the layout's icon-only ArrowRight (last button). */
async function forward(page) {
  const arrow = page.locator('[data-layout="onboarding"] button').last();
  await arrow.click();
  await page.waitForTimeout(1_500);
}

test("02 wizard left a multi-user instance with the admin", async ({
  request,
}) => {
  const res = await request.get("/api/setup-complete");
  expect(res.ok()).toBe(true);
  const keys = await res.json();
  expect(keys.MultiUserMode).toBe(true);
});

let WORKSPACE_SLUG = "e2e-gate-docs";

test("03 admin logs in on a de-branded login page", async ({ page }) => {
  const outbound = [];
  page.on("request", (r) => outbound.push(new URL(r.url()).hostname));
  await page.goto("/login");
  await expect(page.locator('button:has-text("Login")')).toBeVisible();
  expect(await page.textContent("body")).not.toContain("AnythingLLM");
  expect(outbound.filter((h) => /posthog|anythingllm/i.test(h))).toHaveLength(
    0
  );

  await page.locator('input[name="username"]').fill(ADMIN.username);
  await page.locator('input[name="password"]').fill(ADMIN.password);
  await page.locator('button:has-text("Login")').click();
  await expect(
    page.getByText(/how can i help|send a message/i).first()
  ).toBeVisible({ timeout: 30_000 });
});

test("04 create workspace", async ({ page }) => {
  await login(page, ADMIN);
  const res = await authedFetch(page, "/api/workspace/new", {
    method: "POST",
    data: { name: WORKSPACE_NAME },
  });
  expect(res.status()).toBe(200);
  const { workspace } = await res.json();
  WORKSPACE_SLUG = workspace.slug;
  await page.goto(`/workspace/${WORKSPACE_SLUG}`);
  await expect(
    page.getByText(/how can i help|send a message/i).first()
  ).toBeVisible({ timeout: 30_000 });
});

test("05 upload a small .txt document and wait for embedding", async ({
  page,
}) => {
  await login(page, ADMIN);
  await page.goto(`/workspace/${WORKSPACE_SLUG}/settings/documents`);
  await page.setInputFiles(
    'input[type="file"]',
    {
      name: DOC_NAME,
      mimeType: "text/plain",
      buffer: Buffer.from(
        "The secret codeword for the E2E gate is fortytwo. This document exists to be cited."
      ),
    },
    { timeout: 30_000 }
  );
  await expect(page.getByText(DOC_NAME).first()).toBeVisible({
    timeout: 90_000,
  });
  await expect
    .poll(
      async () => {
        const docs = await authedFetch(
          page,
          `/api/workspace/${WORKSPACE_SLUG}`
        );
        return (await docs.text()).includes(DOC_NAME);
      },
      { timeout: 120_000 }
    )
    .toBe(true);
});

test("06 chat answers with a citation pointing at the upload", async ({
  page,
}) => {
  await login(page, ADMIN);
  await page.goto(`/workspace/${WORKSPACE_SLUG}`);
  const prompt = page.locator("textarea").first();
  await prompt.waitFor({ state: "visible", timeout: 30_000 });
  await prompt.fill("What is the secret codeword?");
  await prompt.press("Enter");
  // Assert a citation naming the uploaded doc appears — never the answer's
  // content (mock LLM is canned anyway). The citation block renders the doc
  // title once RAG sources are attached to the reply.
  await expect(page.getByText(DOC_NAME).first()).toBeVisible({
    timeout: 90_000,
  });
});

test("07 admin creates a member user via admin UI", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/settings/users");
  await page.getByText("Add user").first().click();
  await page.locator('input[name="username"]').fill(MEMBER.username);
  await page.locator('input[name="password"]').fill(MEMBER.password);
  await page
    .locator('button:has-text("Create Account"), button:has-text("Save"), button:has-text("Add")')
    .last()
    .click();
  await expect(page.getByText(MEMBER.username).first()).toBeVisible({
    timeout: 30_000,
  });
});

test("08 admin creates an API key via admin UI", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/settings/api-keys");
  await page
    .getByRole("button", { name: /generate|create|new api key/i })
    .click();
  await expect(page.getByText(/apw-key-/).first()).toBeVisible({
    timeout: 30_000,
  });
});

test("09 audit log shows the flow's events", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/settings/event-logs");
  await expect(page.getByText(/login|multi.?user/i).first()).toBeVisible({
    timeout: 30_000,
  });
});

test("10 member cannot see admin UI or hit admin routes", async ({ page }) => {
  await login(page, MEMBER);
  // No admin/settings entry in the sidebar for a default user.
  await expect(page.getByRole("link", { name: /settings/i })).toHaveCount(0);
  // Admin route denied through the same browser session.
  const res = await page.request.get("/api/system/env-dump");
  expect(res.status()).toBe(401);
});

test("11 restart resilience: data survives container restart", async ({
  request,
  page,
}) => {
  const { execSync } = require("child_process");
  execSync(`${UP_SCRIPT} restart-app`, { stdio: "ignore" });

  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) {
    ready = (await request.get("/api/ping").catch(() => null))?.ok();
    if (!ready) await new Promise((r) => setTimeout(r, 1000));
  }
  expect(ready).toBe(true);

  // Same credentials from before the restart still work; workspace survives.
  await login(page, ADMIN);
  const ws = await authedFetch(page, `/api/workspace/${WORKSPACE_SLUG}`);
  expect(ws.status()).toBe(200);
  expect((await ws.text()).includes(DOC_NAME)).toBe(true);
});

test("12 logout returns to login", async ({ page }) => {
  await login(page, ADMIN);
  // Avatar button (top-right circle) opens the account menu; its last item
  // clears the session.
  await page.locator(".absolute.top-3.right-4 > button").click();
  await page.waitForTimeout(500);
  const menu = page.locator(".absolute.top-12.right-0 button");
  const count = await menu.count();
  expect(count).toBeGreaterThan(0);
  await menu.nth(count - 1).click();
  await expect(
    page.locator('button:has-text("Login")')
  ).toBeVisible({ timeout: 30_000 });
});
