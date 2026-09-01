# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: phase0-gate.spec.js >> 01 onboarding completes and lands in workspace
- Location: tests/phase0-gate.spec.js:14:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText(/how can i help|send a message/i).first()
Expected: visible
Timeout: 60000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 60000ms
  - waiting for getByText(/how can i help|send a message/i).first()

```

```yaml
- button "Back":
  - img
- heading "LLM Preference" [level=1]
- paragraph: ApproofWorkspace can work with many LLM providers. This will be the service which handles chatting.
- img
- textbox "Search LLM providers"
- img "OpenAI logo"
- text: OpenAI The standard option for most non-commercial use.
- img "Azure OpenAI logo"
- text: Azure OpenAI The enterprise option of OpenAI hosted on Azure services.
- img "Anthropic logo"
- text: Anthropic A friendly AI Assistant hosted by Anthropic.
- img "Gemini logo"
- text: Gemini Google's largest and most capable AI model
- img "NVIDIA NIM logo"
- text: NVIDIA NIM Run full parameter LLMs directly on your NVIDIA RTX GPU using NVIDIA NIM.
- img "Ollama logo"
- text: Ollama Run LLMs locally on your own machine.
- img "LM Studio logo"
- text: LM Studio Discover, download, and run thousands of cutting edge LLMs in a few clicks.
- img "llmman logo"
- text: llmman Run LLMs locally using llmman.
- img "Lemonade logo"
- text: Lemonade Run local LLMs, ASR, TTS, and more in a single unified AI runtime.
- img "oMLX logo"
- text: oMLX Run MLX models on Apple Silicon with smart caching.
- img "Local AI logo"
- text: Local AI Run LLMs locally on your own machine.
- img "SambaNova logo"
- text: SambaNova Run open source models from SambaNova.
- img "Novita AI logo"
- text: Novita AI Reliable, Scalable, and Cost-Effective for LLMs from Novita AI
- img "KoboldCPP logo"
- text: KoboldCPP Run local LLMs using koboldcpp.
- img "Oobabooga Web UI logo"
- text: Oobabooga Web UI Run local LLMs using Oobabooga's Text Generation Web UI.
- img "Together AI logo"
- text: Together AI Run open source models from Together AI.
- img "Fireworks AI logo"
- text: Fireworks AI The fastest and most efficient inference engine to build production-ready, compound AI systems.
- img "Mistral logo"
- text: Mistral Run open source models from Mistral AI.
- img "Perplexity AI logo"
- text: Perplexity AI Run powerful and internet-connected models hosted by Perplexity AI.
- img "OpenRouter logo"
- text: OpenRouter A unified interface for LLMs.
- img "Groq logo"
- text: Groq The fastest LLM inferencing available for real-time AI applications.
- img "Cohere logo"
- text: Cohere Run Cohere's powerful Command models.
- img "LiteLLM logo"
- text: LiteLLM Run LiteLLM's OpenAI compatible proxy for various LLMs.
- img "DeepSeek logo"
- text: DeepSeek Run DeepSeek's powerful LLMs.
- img "PPIO logo"
- text: PPIO Run stable and cost-efficient open-source LLM APIs, such as DeepSeek, Llama, Qwen etc.
- img "APIpie logo"
- text: APIpie A unified API of AI services from leading providers
- img "Generic OpenAI logo"
- text: Generic OpenAI Connect to any OpenAi-compatible service via a custom configuration
- img "AWS Bedrock logo"
- text: AWS Bedrock Run powerful foundation models privately with AWS Bedrock.
- img "Google Vertex AI logo"
- text: Google Vertex AI Run Gemini models through your Google Cloud project.
- img "Privatemode logo"
- text: Privatemode Run LLMs with end-to-end encryption.
- img "xAI logo"
- text: xAI Run xAI's powerful LLMs like Grok-2 and more.
- img "Z.AI logo"
- text: Z.AI Run Z.AI's powerful GLM models.
- img "Moonshot AI logo"
- text: Moonshot AI Run Moonshot AI's powerful LLMs.
- img "CometAPI logo"
- text: CometAPI 500+ AI Models all in one API.
- img "GiteeAI logo"
- text: GiteeAI Run GiteeAI's powerful LLMs.
- img "Minimax logo"
- text: Minimax Run Minimax's powerful M2 LLMs.
- img "Cerebras logo"
- text: Cerebras Run models at instant speed on Cerebras inference. Base URL
- 'textbox "eg: https://proxy.openai.com"': http://mock-llm:8080/v1
- text: API Key
- textbox "Generic service API Key": "********************"
- text: Selected Model
- textbox "Model id used for chat requests": mock-llm
- text: Model context window
- 'spinbutton "Content window limit (eg: 4096)"': "4096"
- text: Max Tokens
- 'spinbutton "Max tokens per request (eg: 1024)"': "1024"
- button "Continue":
  - img
```

# Test source

```ts
  1   | const { test, expect } = require("@playwright/test");
  2   | 
  3   | /**
  4   |  * Phase 0 closing gate — one ordered flow over the real docker stack
  5   |  * (e2e/scripts/up.sh): onboarding → login → workspace → upload → chat+citation
  6   |  * → admin user/key → audit → multi-user negative → de-brand → restart.
  7   |  * workers=1 in playwright.config: each test depends on the previous state.
  8   |  */
  9   | 
  10  | const ADMIN = { username: "e2e-admin", password: "E2eAdmin!2345" };
  11  | const MEMBER = { username: "e2e-member", password: "E2eMember!2345" };
  12  | const DOC_NAME = "e2e-citation-source.txt";
  13  | 
  14  | test("01 onboarding completes and lands in workspace", async ({ page }) => {
  15  |   const outbound = [];
  16  |   page.on("request", (r) => outbound.push(new URL(r.url()).hostname));
  17  | 
  18  |   await page.goto("/onboarding");
  19  |   await expect(page.getByText(/get started/i)).toBeVisible({ timeout: 60_000 });
  20  | 
  21  |   // De-brand: no AnythingLLM anywhere on onboarding, no posthog/anythingllm calls.
  22  |   const body = await page.textContent("body");
  23  |   expect(body).not.toContain("AnythingLLM");
  24  |   expect(
  25  |     outbound.filter((h) => /posthog|anythingllm/i.test(h))
  26  |   ).toHaveLength(0);
  27  | 
  28  |   await page.getByRole("button", { name: /get started/i }).click();
  29  | 
  30  |   // Walk the steps. The stack env pre-configures generic-openai LLM +
  31  |   // embedder, so provider steps render pre-filled and just need advancing.
  32  |   // User setup: choose "My team" so a multi-user admin exists for later tests.
  33  |   for (let step = 0; step < 10; step++) {
  34  |     const myTeam = page.getByText("My team", { exact: false }).first();
  35  |     if (await myTeam.isVisible().catch(() => false)) {
  36  |       await myTeam.click();
  37  |       await page.waitForTimeout(500);
  38  |     }
  39  |     const username = page.getByLabel(/username/i).first();
  40  |     if (await username.isVisible().catch(() => false)) {
  41  |       await username.fill(ADMIN.username);
  42  |       await page
  43  |         .getByLabel(/password/i)
  44  |         .first()
  45  |         .fill(ADMIN.password);
  46  |     }
  47  |     const provider = page.getByText(/generic openai/i).first();
  48  |     if (await provider.isVisible().catch(() => false))
  49  |       await provider.click().catch(() => {});
  50  | 
  51  |     const forward = page
  52  |       .locator(
  53  |         'button:has-text("Continue"), button:has-text("Next"), button:has-text("Finish"), button:has-text("Save"), button:has-text("Create"), button:has-text("Confirm"), button:has-text("Get Started")'
  54  |       )
  55  |       .last();
  56  |     if (!(await forward.isVisible().catch(() => false))) break;
  57  |     await forward.click().catch(() => {});
  58  |     await page.waitForTimeout(1_500);
  59  | 
  60  |     const chatVisible = await page
  61  |       .getByText(/how can i help|send a message/i)
  62  |       .first()
  63  |       .isVisible()
  64  |       .catch(() => false);
  65  |     if (chatVisible) break;
  66  |   }
  67  | 
  68  |   await expect(
  69  |     page.getByText(/how can i help|send a message/i).first()
> 70  |   ).toBeVisible({ timeout: 60_000 });
      |     ^ Error: expect(locator).toBeVisible() failed
  71  | });
  72  | 
  73  | test("02 login page is de-branded", async ({ page }) => {
  74  |   const outbound = [];
  75  |   page.on("request", (r) => outbound.push(new URL(r.url()).hostname));
  76  |   await page.goto("/login");
  77  |   await expect(page.getByRole("button", { name: /login/i })).toBeVisible();
  78  |   const body = await page.textContent("body");
  79  |   expect(body).not.toContain("AnythingLLM");
  80  |   expect(
  81  |     outbound.filter((h) => /posthog|anythingllm/i.test(h))
  82  |   ).toHaveLength(0);
  83  | });
  84  | 
  85  | test("03 admin logs in", async ({ page }) => {
  86  |   await page.goto("/login");
  87  |   await page.getByLabel(/username/i).fill(ADMIN.username);
  88  |   await page.getByLabel(/password/i).fill(ADMIN.password);
  89  |   await page.getByRole("button", { name: /login/i }).click();
  90  |   await expect(page.getByText(/workspace/i).first()).toBeVisible({
  91  |     timeout: 30_000,
  92  |   });
  93  | });
  94  | 
  95  | test("04 upload a small .txt document", async ({ page }) => {
  96  |   await page.goto("/workspace/e2e-gate-doc/settings/documents");
  97  |   await page.setInputFiles(
  98  |     'input[type="file"]',
  99  |     {
  100 |       name: DOC_NAME,
  101 |       mimeType: "text/plain",
  102 |       buffer: Buffer.from(
  103 |         "The secret codeword for the E2E gate is fortytwo. This document exists to be cited."
  104 |       ),
  105 |     },
  106 |     { timeout: 30_000 }
  107 |   );
  108 |   await expect(page.getByText(DOC_NAME).first()).toBeVisible({
  109 |     timeout: 60_000,
  110 |   });
  111 |   // Wait for embedding to finish (mock embedder is instant, UI polls).
  112 |   await expect
  113 |     .poll(async () => (await page.textContent("body")) ?? "", { timeout: 60_000 })
  114 |     .not.toContain(/in progress|processing/i);
  115 | });
  116 | 
  117 | test("05 chat answers with a citation pointing at the upload", async ({ page }) => {
  118 |   await page.goto("/workspace/e2e-gate-doc");
  119 |   await page.getByPlaceholder(/message|ask/i).fill("What is the secret codeword?");
  120 |   await page.keyboard.press("Enter");
  121 |   // Response non-empty (NOT its content) + citation citing the uploaded doc.
  122 |   const response = page.locator(".response, [class*='response']").last();
  123 |   await expect(response).toBeVisible({ timeout: 60_000 });
  124 |   await expect
  125 |     .poll(async () => (await response.textContent()) ?? "", { timeout: 60_000 })
  126 |     .toBeTruthy();
  127 |   await expect(page.getByText(DOC_NAME).first()).toBeVisible({
  128 |     timeout: 30_000,
  129 |   });
  130 | });
  131 | 
  132 | test("06 admin creates a member user via admin UI", async ({ page }) => {
  133 |   await page.goto("/settings/security");
  134 |   await page.getByRole("button", { name: /add user/i }).click();
  135 |   await page.getByLabel(/username/i).fill(MEMBER.username);
  136 |   await page.getByLabel(/password/i).fill(MEMBER.password);
  137 |   await page.getByRole("button", { name: /create|save|add/i }).last().click();
  138 |   await expect(page.getByText(MEMBER.username).first()).toBeVisible({
  139 |     timeout: 30_000,
  140 |   });
  141 | });
  142 | 
  143 | test("07 admin creates an API key via admin UI", async ({ page }) => {
  144 |   await page.goto("/settings/api-keys");
  145 |   await page.getByRole("button", { name: /generate|create|new api key/i }).click();
  146 |   await expect(page.getByText(/apw-key-/).first()).toBeVisible({
  147 |     timeout: 30_000,
  148 |   });
  149 | });
  150 | 
  151 | test("08 audit log shows login and key events", async ({ page }) => {
  152 |   await page.goto("/settings/events");
  153 |   await expect(page.getByText(/login/i).first()).toBeVisible({
  154 |     timeout: 30_000,
  155 |   });
  156 |   await expect(
  157 |     page.getByText(/api.?key.*(created|generate)/i).first()
  158 |   ).toBeVisible({ timeout: 30_000 });
  159 | });
  160 | 
  161 | test("09 member cannot see admin menu or hit admin routes", async ({ page }) => {
  162 |   await page.goto("/login");
  163 |   await page.getByLabel(/username/i).fill(MEMBER.username);
  164 |   await page.getByLabel(/password/i).fill(MEMBER.password);
  165 |   await page.getByRole("button", { name: /login/i }).click();
  166 |   await expect(page.getByText(/workspace/i).first()).toBeVisible({
  167 |     timeout: 30_000,
  168 |   });
  169 |   await expect(page.getByText(/admin/i)).toHaveCount(0);
  170 | 
```