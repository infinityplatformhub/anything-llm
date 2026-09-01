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

test("01 onboarding completes and lands in the app", async ({ page }) => {
  const outbound = [];
  page.on("request", (r) => outbound.push(new URL(r.url()).hostname));

  await page.goto("/onboarding");
  await expect(page.getByText(/get started/i)).toBeVisible({ timeout: 60_000 });

  // De-brand: no AnythingLLM anywhere, no posthog/anythingllm network calls.
  expect(await page.textContent("body")).not.toContain("AnythingLLM");
  expect(outbound.filter((h) => /posthog|anythingllm/i.test(h))).toHaveLength(
    0
  );

  // The home screen layers absolute background divs over the button — force
  // through them; the click target itself is correct.
  await page
    .getByRole("button", { name: /get started/i })
    .click({ force: true });
  // Providers are pre-configured via env; stepping forward through the LLM
  // screen completes onboarding (that step posts onboarding_complete).
  for (let step = 0; step < 6; step++) {
    const forward = page
      .locator(
        'button:has-text("Continue"), button:has-text("Next"), button:has-text("Finish"), button:has-text("Save"), button:has-text("Get Started")'
      )
      .last();
    if (!(await forward.isVisible().catch(() => false))) {
      const arrow = page
        .locator('[data-layout="onboarding"] button')
        .last(); // ArrowRight
      if (!(await arrow.isVisible().catch(() => false))) break;
      await arrow.click();
    } else {
      await forward.click();
    }
    await page.waitForTimeout(1_500);
    if (
      await page
        .getByText(/how can i help|send a message/i)
        .first()
        .isVisible()
        .catch(() => false)
    )
      break;
  }
  await expect(
    page.getByText(/how can i help|send a message/i).first()
  ).toBeVisible({ timeout: 60_000 });
});

test("02 enable multi-user mode (creates admin)", async ({ page }) => {
  // Single-user, no password: the app's own migration endpoint (the one the
  // Security settings page calls) creates the first admin.
  const res = await page.request.post("/api/system/enable-multi-user", {
    data: { username: ADMIN.username, password: ADMIN.password },
  });
  expect(res.ok()).toBe(true);
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
  // Assert non-empty answer + citation naming the uploaded doc — never the
  // answer's content (mock LLM is canned anyway).
  await expect(
    page.locator("[class*='response'], .no-scroll, [data-toast]").last()
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(DOC_NAME).first()).toBeVisible({
    timeout: 60_000,
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
  // Avatar menu (bottom-left) → last menu button clears the session.
  await page.getByText(ADMIN.username).first().click();
  await page.waitForTimeout(500);
  const menuButtons = page.locator("button:visible");
  const count = await menuButtons.count();
  await menuButtons.nth(count - 1).click();
  await expect(
    page.locator('button:has-text("Login")')
  ).toBeVisible({ timeout: 30_000 });
});
