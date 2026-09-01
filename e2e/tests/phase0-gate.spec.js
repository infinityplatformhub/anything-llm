const { test, expect } = require("@playwright/test");

/**
 * Phase 0 closing gate — one ordered flow over the real docker stack
 * (e2e/scripts/up.sh): onboarding → login → workspace → upload → chat+citation
 * → admin user/key → audit → multi-user negative → de-brand → restart.
 * workers=1 in playwright.config: each test depends on the previous state.
 */

const ADMIN = { username: "e2e-admin", password: "E2eAdmin!2345" };
const MEMBER = { username: "e2e-member", password: "E2eMember!2345" };
const DOC_NAME = "e2e-citation-source.txt";

test("01 onboarding completes and lands in workspace", async ({ page }) => {
  const outbound = [];
  page.on("request", (r) => outbound.push(new URL(r.url()).hostname));

  await page.goto("/onboarding");
  await expect(page.getByText(/get started/i)).toBeVisible({ timeout: 60_000 });

  // De-brand: no AnythingLLM anywhere on onboarding, no posthog/anythingllm calls.
  const body = await page.textContent("body");
  expect(body).not.toContain("AnythingLLM");
  expect(
    outbound.filter((h) => /posthog|anythingllm/i.test(h))
  ).toHaveLength(0);

  await page.getByRole("button", { name: /get started/i }).click();

  // Walk the steps. The stack env pre-configures generic-openai LLM +
  // embedder, so provider steps render pre-filled and just need advancing.
  // User setup: choose "My team" so a multi-user admin exists for later tests.
  for (let step = 0; step < 10; step++) {
    const myTeam = page.getByText("My team", { exact: false }).first();
    if (await myTeam.isVisible().catch(() => false)) {
      await myTeam.click();
      await page.waitForTimeout(500);
    }
    const username = page.getByLabel(/username/i).first();
    if (await username.isVisible().catch(() => false)) {
      await username.fill(ADMIN.username);
      await page
        .getByLabel(/password/i)
        .first()
        .fill(ADMIN.password);
    }
    const provider = page.getByText(/generic openai/i).first();
    if (await provider.isVisible().catch(() => false))
      await provider.click().catch(() => {});

    const forward = page
      .locator(
        'button:has-text("Continue"), button:has-text("Next"), button:has-text("Finish"), button:has-text("Save"), button:has-text("Create"), button:has-text("Confirm"), button:has-text("Get Started")'
      )
      .last();
    if (!(await forward.isVisible().catch(() => false))) break;
    await forward.click().catch(() => {});
    await page.waitForTimeout(1_500);

    const chatVisible = await page
      .getByText(/how can i help|send a message/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (chatVisible) break;
  }

  await expect(
    page.getByText(/how can i help|send a message/i).first()
  ).toBeVisible({ timeout: 60_000 });
});

test("02 login page is de-branded", async ({ page }) => {
  const outbound = [];
  page.on("request", (r) => outbound.push(new URL(r.url()).hostname));
  await page.goto("/login");
  await expect(page.getByRole("button", { name: /login/i })).toBeVisible();
  const body = await page.textContent("body");
  expect(body).not.toContain("AnythingLLM");
  expect(
    outbound.filter((h) => /posthog|anythingllm/i.test(h))
  ).toHaveLength(0);
});

test("03 admin logs in", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(ADMIN.username);
  await page.getByLabel(/password/i).fill(ADMIN.password);
  await page.getByRole("button", { name: /login/i }).click();
  await expect(page.getByText(/workspace/i).first()).toBeVisible({
    timeout: 30_000,
  });
});

test("04 upload a small .txt document", async ({ page }) => {
  await page.goto("/workspace/e2e-gate-doc/settings/documents");
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
    timeout: 60_000,
  });
  // Wait for embedding to finish (mock embedder is instant, UI polls).
  await expect
    .poll(async () => (await page.textContent("body")) ?? "", { timeout: 60_000 })
    .not.toContain(/in progress|processing/i);
});

test("05 chat answers with a citation pointing at the upload", async ({ page }) => {
  await page.goto("/workspace/e2e-gate-doc");
  await page.getByPlaceholder(/message|ask/i).fill("What is the secret codeword?");
  await page.keyboard.press("Enter");
  // Response non-empty (NOT its content) + citation citing the uploaded doc.
  const response = page.locator(".response, [class*='response']").last();
  await expect(response).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => (await response.textContent()) ?? "", { timeout: 60_000 })
    .toBeTruthy();
  await expect(page.getByText(DOC_NAME).first()).toBeVisible({
    timeout: 30_000,
  });
});

test("06 admin creates a member user via admin UI", async ({ page }) => {
  await page.goto("/settings/security");
  await page.getByRole("button", { name: /add user/i }).click();
  await page.getByLabel(/username/i).fill(MEMBER.username);
  await page.getByLabel(/password/i).fill(MEMBER.password);
  await page.getByRole("button", { name: /create|save|add/i }).last().click();
  await expect(page.getByText(MEMBER.username).first()).toBeVisible({
    timeout: 30_000,
  });
});

test("07 admin creates an API key via admin UI", async ({ page }) => {
  await page.goto("/settings/api-keys");
  await page.getByRole("button", { name: /generate|create|new api key/i }).click();
  await expect(page.getByText(/apw-key-/).first()).toBeVisible({
    timeout: 30_000,
  });
});

test("08 audit log shows login and key events", async ({ page }) => {
  await page.goto("/settings/events");
  await expect(page.getByText(/login/i).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByText(/api.?key.*(created|generate)/i).first()
  ).toBeVisible({ timeout: 30_000 });
});

test("09 member cannot see admin menu or hit admin routes", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(MEMBER.username);
  await page.getByLabel(/password/i).fill(MEMBER.password);
  await page.getByRole("button", { name: /login/i }).click();
  await expect(page.getByText(/workspace/i).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/admin/i)).toHaveCount(0);

  // Admin route through the UI: member gets bounced, not rendered.
  const res = await page.request.get("/api/system/env-dump");
  expect(res.status()).toBe(401);
});

test("10 restart resilience: data survives container restart", async ({ request }) => {
  const { execSync } = require("child_process");
  execSync("e2e/scripts/up.sh restart-app", { cwd: process.env.E2E_ROOT });

  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = (await request.get("/api/ping").catch(() => null))?.ok();
    if (!ready) await new Promise((r) => setTimeout(r, 1000));
  }
  expect(ready).toBe(true);

  // Login again with the SAME credentials created before restart.
  const login = await request.post("/api/request-token", {
    data: { username: ADMIN.username, password: ADMIN.password },
  });
  expect(login.ok()).toBe(true);
  expect((await login.json()).valid).toBe(true);
});

test("11 logout returns to login", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/username/i).fill(ADMIN.username);
  await page.getByLabel(/password/i).fill(ADMIN.password);
  await page.getByRole("button", { name: /login/i }).click();
  await expect(page.getByText(/workspace/i).first()).toBeVisible();
  await page.getByRole("button", { name: /logout|sign out/i }).first().click();
  await expect(page.getByRole("button", { name: /login/i })).toBeVisible({
    timeout: 30_000,
  });
});
