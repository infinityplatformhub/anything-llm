/** Manager setting writes over real auth and HTTP routing. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "manager-forbidden-"));
const schema = `manager_forbidden_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.API_KEY_PEPPER = "manager-forbidden-pepper-32-bytes";
process.env.SIG_KEY = "manager-forbidden-sig-key-long-enough";
process.env.STORAGE_DIR = path.join(tempDir, "storage");
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
  throw new Error("DATABASE_URL must point to PostgreSQL for HTTP tests");
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = databaseUrl.toString();
fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });

execFileSync(
  path.resolve(__dirname, "../../node_modules/.bin/prisma"),
  [
    "migrate",
    "deploy",
    "--schema",
    path.resolve(__dirname, "../../prisma/schema.prisma"),
  ],
  { cwd: path.resolve(__dirname, "../.."), env: process.env, stdio: "ignore" }
);

jest.mock("../../utils/logger", () => () => {});
jest.mock("../../utils/boot", () => ({
  bootHTTP: jest.fn(),
  bootSSL: jest.fn(),
}));
jest.mock("../../utils/boot/patchSdkTimeouts", () => jest.fn());
jest.mock("../../utils/AiProviders/modelMap", () => ({
  MODEL_MAP: { get: jest.fn(() => null) },
}));
jest.mock("../../utils/helpers/modelPricing", () => ({
  addChatCostToMetrics: jest.fn((metrics) => metrics),
}));
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn(), flush: jest.fn() },
}));
jest.mock("../../utils/boot/MetaGenerator", () => ({
  MetaGenerator: jest.fn().mockImplementation(() => ({
    generate: jest.fn(),
    generateManifest: jest.fn(),
  })),
}));

const { CommunicationKey } = require("../../utils/comKey");
new CommunicationKey(true);

const request = require("supertest");
const bcrypt = require("bcryptjs");
const prisma = require("../../utils/prisma");
const { app } = require("../../index");
const { SystemSettings } = require("../../models/systemSettings");
const {
  managerAllowedFields,
} = require("../../utils/managerSystemPreferences");
const { makeJWT } = require("../../utils/http");
const repository = require("../../utils/authorization/policyRepository");
const {
  DatabaseAuthorizationEngine,
} = require("../../utils/authorization/engine");
const {
  SERVICE_PRINCIPALS,
} = require("../../utils/authorization/actorResolver");

const engine = new DatabaseAuthorizationEngine({ db: prisma });
const resource = { type: "organization", id: "1", orgId: 1, workspaceId: null };
const actorFor = (user) => ({ type: "user", id: String(user.id), orgId: 1 });
const authFor = (user) =>
  `Bearer ${makeJWT({ id: user.id, username: user.username })}`;
const post = (user, route, body) =>
  request(app).post(route).set("Authorization", authFor(user)).send(body);
const update = (user, body) =>
  post(user, "/api/admin/system-preferences", body);

let manager;
let admin;
const forbiddenFields = SystemSettings.supportedFields.filter(
  (key) => !managerAllowedFields.includes(key)
);

beforeAll(async () => {
  const roles = await prisma.roles.findMany({
    where: { scope: "org", name: { in: ["setup_admin", "super_admin"] } },
  });
  const roleId = Object.fromEntries(roles.map((role) => [role.name, role.id]));
  [manager, admin] = await Promise.all(
    ["manager-forbidden-manager", "manager-forbidden-admin"].map((username) =>
      prisma.users.create({
        data: {
          username,
          password: bcrypt.hashSync("Pw123456!", 10),
          role: "admin",
        },
      })
    )
  );
  await repository.grantRole({
    actor: SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: String(manager.id),
    roleId: roleId.setup_admin,
    db: prisma,
  });
  await repository.grantRole({
    actor: SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: String(admin.id),
    roleId: roleId.super_admin,
    db: prisma,
  });
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });

  // Premise guard: exercise exact grants used by endpoint branch, not legacy role strings.
  await expect(
    engine.authorize({
      actor: actorFor(manager),
      action: "settings.write",
      resource,
    })
  ).resolves.toMatchObject({ allowed: true });
  await expect(
    engine.authorize({
      actor: actorFor(manager),
      action: "system.write",
      resource,
    })
  ).resolves.toMatchObject({ allowed: false });
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.system_settings.deleteMany({
    where: {
      label: {
        in: [
          "memory_enabled",
          "support_email",
          "not_a_real_key",
          "hub_api_key",
          "default_system_prompt",
          "logo_filename",
          "experimental_live_file_sync",
        ],
      },
    },
  });
});

describe("issue 78 manager forbidden setting keys", () => {
  it("keeps protected and supported overlap explicit", () => {
    const overlap = SystemSettings.protectedFields.filter((key) =>
      SystemSettings.supportedFields.includes(key)
    );
    // Guard against this policy assertion becoming vacuous if the overlap disappears.
    expect(overlap.length).toBeGreaterThan(0);
    expect(overlap).toEqual(["hub_api_key"]);
  });

  it("refuses memory_enabled and leaves its row unchanged", async () => {
    await prisma.system_settings.create({
      data: { label: "memory_enabled", value: "false" },
    });

    const response = await update(manager, { memory_enabled: "true" });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      success: false,
      code: "forbidden_keys",
      forbiddenKeys: ["memory_enabled"],
      forbiddenKeyCount: 1,
    });
    await expect(
      prisma.system_settings.findUnique({ where: { label: "memory_enabled" } })
    ).resolves.toMatchObject({ value: "false" });
  });

  it("still lets manager write support_email", async () => {
    const response = await update(manager, {
      support_email: "manager@example.com",
    });

    expect(response.status).toBe(200);
    await expect(
      prisma.system_settings.findUnique({ where: { label: "support_email" } })
    ).resolves.toMatchObject({ value: "manager@example.com" });
  });

  it("lets actor holding system.write write same key", async () => {
    const response = await update(admin, { memory_enabled: "true" });

    expect(response.status).toBe(200);
    await expect(
      prisma.system_settings.findUnique({ where: { label: "memory_enabled" } })
    ).resolves.toMatchObject({ value: "true" });
  });

  it.each(forbiddenFields)(
    "refuses manager write to supported key %s",
    async (key) => {
      const response = await update(manager, { [key]: "value" });

      expect(response.status).toBe(403);
      expect(response.body.forbiddenKeys).toEqual([key]);
    }
  );

  it("names only forbidden keys caller sent", async () => {
    const response = await update(manager, { memory_enabled: "true" });
    const serialized = JSON.stringify(response.body);

    expect(response.status).toBe(403);
    expect(response.body.forbiddenKeys).toEqual(["memory_enabled"]);
    for (const absent of [...forbiddenFields, ...managerAllowedFields]) {
      if (absent !== "memory_enabled") expect(serialized).not.toContain(absent);
    }
  });

  it("refuses mixed unknown and forbidden keys before vocabulary validation", async () => {
    const response = await update(manager, {
      not_a_real_key: "x",
      memory_enabled: "true",
    });

    expect(response.status).toBe(403);
    expect(response.body.forbiddenKeys).toEqual(["memory_enabled"]);
  });

  it("refuses hub_api_key through community hub route", async () => {
    const response = await post(manager, "/api/community-hub/settings", {
      hub_api_key: "manager-key",
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: "forbidden_keys",
      forbiddenKeys: ["hub_api_key"],
    });
    await expect(
      prisma.system_settings.findUnique({ where: { label: "hub_api_key" } })
    ).resolves.toBeNull();
  });

  it("keeps community hub route working for actor holding system.write", async () => {
    const response = await post(admin, "/api/community-hub/settings", {
      hub_api_key: "admin-key",
    });

    expect(response.status).toBe(200);
    await expect(
      prisma.system_settings.findUnique({ where: { label: "hub_api_key" } })
    ).resolves.toMatchObject({ value: "admin-key" });
  });

  it("refuses default_system_prompt through system route", async () => {
    const response = await post(manager, "/api/system/default-system-prompt", {
      defaultSystemPrompt: "manager prompt",
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: "forbidden_keys",
      forbiddenKeys: ["default_system_prompt"],
    });
    await expect(
      prisma.system_settings.findUnique({
        where: { label: "default_system_prompt" },
      })
    ).resolves.toBeNull();
  });

  it("keeps default system prompt route working for actor holding system.write", async () => {
    const response = await post(admin, "/api/system/default-system-prompt", {
      defaultSystemPrompt: "admin prompt",
    });

    expect(response.status).toBe(200);
    await expect(
      prisma.system_settings.findUnique({
        where: { label: "default_system_prompt" },
      })
    ).resolves.toMatchObject({ value: "admin prompt" });
  });

  it.each(["multi_user_mode", "onboarding_complete"])(
    "refuses manager write to protected key %s",
    async (key) => {
      const response = await update(manager, { [key]: "true" });

      expect(response.status).toBe(403);
      expect(response.body.forbiddenKeys).toEqual([key]);
    }
  );

  it("keeps protected-key model response for actor holding system.write", async () => {
    const response = await update(admin, { multi_user_mode: "false" });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: "protected_keys",
      protectedKeys: ["multi_user_mode"],
    });
  });

  it("refuses manager multipart logo upload", async () => {
    const response = await request(app)
      .post("/api/system/upload-logo")
      .set("Authorization", authFor(manager))
      .attach("logo", Buffer.from("logo"), "manager-logo.png");

    expect(response.status).toBe(403);
    expect(response.body.forbiddenKeys).toEqual(["logo_filename"]);
    await expect(
      prisma.system_settings.findUnique({ where: { label: "logo_filename" } })
    ).resolves.toBeNull();
  });

  it("lets actor holding system.write upload logo", async () => {
    const response = await request(app)
      .post("/api/system/upload-logo")
      .set("Authorization", authFor(admin))
      .attach("logo", Buffer.from("logo"), "admin-logo.png");

    expect(response.status).toBe(200);
    await expect(
      prisma.system_settings.findUnique({ where: { label: "logo_filename" } })
    ).resolves.toMatchObject({ value: expect.stringMatching(/\.png$/) });
  });

  it("refuses manager logo removal", async () => {
    const response = await request(app)
      .get("/api/system/remove-logo")
      .set("Authorization", authFor(manager));

    expect(response.status).toBe(403);
    expect(response.body.forbiddenKeys).toEqual(["logo_filename"]);
    await expect(
      prisma.system_settings.findUnique({ where: { label: "logo_filename" } })
    ).resolves.toBeNull();
  });

  it("lets actor holding system.write remove logo", async () => {
    const response = await request(app)
      .get("/api/system/remove-logo")
      .set("Authorization", authFor(admin));

    expect(response.status).toBe(200);
    await expect(
      prisma.system_settings.findUnique({ where: { label: "logo_filename" } })
    ).resolves.toMatchObject({ value: "approofworkspace.png" });
  });

  it("refuses manager live sync toggle", async () => {
    await prisma.system_settings.create({
      data: { label: "experimental_live_file_sync", value: "enabled" },
    });
    const response = await post(manager, "/api/experimental/toggle-live-sync", {
      updatedStatus: false,
    });

    expect(response.status).toBe(403);
    expect(response.body.forbiddenKeys).toEqual([
      "experimental_live_file_sync",
    ]);
    await expect(
      prisma.system_settings.findUnique({
        where: { label: "experimental_live_file_sync" },
      })
    ).resolves.toMatchObject({ value: "enabled" });
  });

  it("lets actor holding system.write toggle live sync", async () => {
    await prisma.system_settings.create({
      data: { label: "experimental_live_file_sync", value: "enabled" },
    });
    const response = await post(admin, "/api/experimental/toggle-live-sync", {
      updatedStatus: false,
    });

    expect(response.status).toBe(200);
    await expect(
      prisma.system_settings.findUnique({
        where: { label: "experimental_live_file_sync" },
      })
    ).resolves.toMatchObject({ value: "disabled" });
  });

  it("lets actor holding system.write write text splitter chunk size", async () => {
    const response = await update(admin, { text_splitter_chunk_size: 512 });

    expect(response.status).toBe(200);
    await expect(
      prisma.system_settings.findUnique({
        where: { label: "text_splitter_chunk_size" },
      })
    ).resolves.toMatchObject({ value: "512" });
  });

  it("refuses manager enable-multi-user before changing the database", async () => {
    const before = await prisma.system_settings.findUnique({
      where: { label: "multi_user_mode" },
    });

    const response = await post(manager, "/api/system/enable-multi-user", {
      username: "escalated-admin",
      password: "Pw123456!",
    });

    expect(response.status).toBe(403);
    await expect(
      prisma.system_settings.findUnique({ where: { label: "multi_user_mode" } })
    ).resolves.toEqual(before);
  });

  it("returns model unknown_keys response for manager unknown keys", async () => {
    const response = await update(manager, { not_a_real_key: "x" });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: "unknown_keys",
      unknownKeys: ["not_a_real_key"],
    });
    await expect(
      prisma.system_settings.findUnique({ where: { label: "not_a_real_key" } })
    ).resolves.toBeNull();
  });
});
