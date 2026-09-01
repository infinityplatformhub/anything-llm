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
const { MOCK_LLM } = require("../config");

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
  if (await recovery.isVisible({ timeout: 15_000 }).catch(() => false)) {
    const dl = page.waitForEvent("download").catch(() => null);
    await page.getByRole("button", { name: /download/i }).click({ force: true });
    (await dl)?.cancel?.();
    // The button relabels to Close only after the download handler ran.
    await page
      .getByRole("button", { name: "Close" })
      .click({ timeout: 15_000 });
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

  // LLM preference: Generic OpenAI → mock provider. This step's submit also
  // completes onboarding and defaults EmbeddingEngine to "native" — the
  // embedder is switched to the mock provider afterwards (test 02), via the
  // settings page the product uses.
  await page
    .locator('[role="button"], div, label')
    .filter({ hasText: /^Generic OpenAI$/ })
    .first()
    .click();
  await page.locator('input[name="GenericOpenAiBasePath"]').fill(MOCK_LLM);
  await page.locator('input[name="GenericOpenAiKey"]').fill("e2e-mock-key");
  // Model field is a disabled <select> while custom-models loads, then a
  // free-form <input>; wait for the input. All required fields must be set —
  // native validation silently blocks the hidden submit otherwise.
  // When the provider lists models, the field renders as a <select>; when the
  // list is empty it is a free-text input. Handle both.
  const modelSelect = page.locator('select[name="GenericOpenAiModelPref"]:not([disabled])');
  const modelInput = page.locator('input[name="GenericOpenAiModelPref"]');
  await expect
    .poll(async () => (await modelSelect.count()) + (await modelInput.count()), {
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
  if (await modelSelect.count()) {
    await modelSelect.selectOption({ index: 0 });
  } else {
    await modelInput.fill("mock-llm");
  }
  await page.locator('input[name="GenericOpenAiTokenLimit"]').fill("4096");
  await page.locator('input[name="GenericOpenAiMaxTokens"]').fill("1024");
  expect(await page.evaluate(() => document.querySelector("form").checkValidity())).toBe(true);
  await forward(page);
  await page.waitForURL(/user-setup/, { timeout: 30_000 });

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

test("02 embedder switched to the mock provider; instance is multi-user", async ({
  page,
  request,
}) => {
  await login(page, ADMIN);
  await page.goto("/settings/embedding-preference");
  // The wizard leaves EmbeddingEngine=native, so the current-provider card
  // shows the built-in embedder. Open the provider list and pick Generic
  // OpenAI — only then do its fields render.
  await page
    .locator("button")
    .filter({ hasText: /Embedder|Zero setup/i })
    .first()
    .click({ force: true });
  await page
    .locator('input[placeholder="Search all embedding providers"]')
    .fill("Generic OpenAI");
  await page.waitForTimeout(1_000);
  // Provider entries render as label/checkbox rows inside the search menu.
  await page
    .getByText("Generic OpenAI", { exact: false })
    .first()
    .click({ force: true });
  await page.waitForTimeout(1_500);

  await page
    .locator('input[name="EmbeddingBasePath"]')
    .fill(MOCK_LLM);
  await page.locator('input[name="EmbeddingModelPref"]').fill("mock-embed");
  const apiKeyField = page.locator('input[name="GenericOpenAiEmbeddingApiKey"]');
  if (await apiKeyField.count()) await apiKeyField.fill("e2e-mock-key");

  const save = page.locator('button:has-text("Save")').last();
  await save.waitFor({ state: "visible", timeout: 30_000 });
  await save.click();
  await page.waitForTimeout(3_000);

  // Prove it stuck: the settings API reports the new engine.
  const keys = await (await request.get("/api/setup-complete")).json();
  expect(keys.results.EmbeddingEngine).toBe("generic-openai");
  expect(keys.results.MultiUserMode).toBe(true);
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

test("05 upload a small .txt document and embed it into the workspace", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await login(page, ADMIN);
  await page.goto(`/workspace/${WORKSPACE_SLUG}`);

  // Upload through the product's own API (the document-picker modal is a
  // React tree whose rows re-render on select; driving it adds flake without
  // testing anything the gate is here to protect). Embedding, citation and
  // restart persistence are still asserted through the real UI below.
  const token = await page.evaluate(() =>
    localStorage.getItem("approofworkspace_authToken")
  );
  const upload = await page.request.post(
    `/api/workspace/${WORKSPACE_SLUG}/upload`,
    {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: {
          name: DOC_NAME,
          mimeType: "text/plain",
          buffer: Buffer.from(
            "The secret codeword for the E2E gate is fortytwo. This document exists to be cited."
          ),
        },
      },
      timeout: 120_000,
    }
  );
  expect(upload.status()).toBe(200);
  expect((await upload.json()).success).toBe(true);

  // The upload response carries no path; the picker reads the folder listing,
  // where each parsed file is custom-documents/<name>.json with the original
  // filename as its title.
  const listing = await authedFetch(
    page,
    "/api/system/local-files?folder=custom-documents&limit=all"
  );
  const parsed = (await listing.json()).documents.find(
    (d) => d.title === DOC_NAME
  );
  expect(parsed).toBeTruthy();
  const docPath = `custom-documents/${parsed.name}`;

  // Embed it into the workspace.
  const embed = await authedFetch(
    page,
    `/api/workspace/${WORKSPACE_SLUG}/update-embeddings`,
    {
      method: "POST",
      data: { adds: [docPath], deletes: [] },
      timeout: 180_000,
    }
  );
  expect(embed.status()).toBe(200);

  // The workspace now reports the document — through the API the UI reads.
  await expect
    .poll(
      async () => {
        const docs = await authedFetch(page, `/api/workspace/${WORKSPACE_SLUG}`);
        return (await docs.text()).includes(DOC_NAME);
      },
      { timeout: 120_000 }
    )
    .toBe(true);

  // Light coverage of the document-picker modal so it is not 0-coverage:
  // open it and confirm the uploaded file is listed under custom-documents.
  await page.reload();
  await page.locator("[data-tooltip-id=upload-workspace]").last().click({ force: true });
  const folderRow = page.getByRole("row", { name: /custom-documents/ }).first();
  await folderRow.waitFor({ state: "visible", timeout: 60_000 });
  const fileRow = page.locator("tr.file-row").filter({ hasText: DOC_NAME }).first();
  for (let i = 0; i < 3; i++) {
    if (await fileRow.isVisible().catch(() => false)) break;
    await folderRow.click();
    await page.waitForTimeout(2_000);
  }
  await expect(fileRow).toBeVisible({ timeout: 30_000 });
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
  // Role select already defaults to "default" (member).
  await page.locator('button[type="submit"]:has-text("Add user")').click();
  await expect(page.getByText(MEMBER.username).first()).toBeVisible({
    timeout: 30_000,
  });
});

test("08 admin creates an API key via admin UI", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/settings/api-keys");
  await page.getByRole("button", { name: "Generate New API Key" }).click();
  await page
    .locator('button[type="submit"]:has-text("Create API Key")')
    .click();
  // The raw key is shown once at creation, inside a readonly <input value>.
  const keyField = page.locator('input[readonly], input[disabled]').first();
  await keyField.waitFor({ state: "visible", timeout: 30_000 });
  expect((await keyField.inputValue()).length).toBeGreaterThan(20);
});

test("09 audit log shows the flow's events", async ({ page }) => {
  await login(page, ADMIN);
  await page.goto("/settings/event-logs");
  // Rows come from the event bus (audit subscriber) — assert real rows exist.
  await expect
    .poll(async () => await page.locator("tbody tr").count(), {
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
  await expect(
    page.locator("tbody").getByText(/login|api_key|workspace/i).first()
  ).toBeVisible({ timeout: 30_000 });
});

test("10 member cannot see admin UI or hit admin routes", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[name="username"]').fill(MEMBER.username);
  await page.locator('input[name="password"]').fill(MEMBER.password);
  await page.locator('button:has-text("Login")').click();
  // A fresh member has no workspaces, so assert the app shell, not the chat UI.
  await expect(page.locator('button:has-text("Login")')).toHaveCount(0, {
    timeout: 30_000,
  });
  // No admin settings entry in the sidebar for a default user.
  await expect(page.getByRole("link", { name: /settings/i })).toHaveCount(0);
  // Admin route denied through the same browser session.
  const res = await authedFetch(page, "/api/env-dump");
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
