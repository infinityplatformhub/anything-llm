const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const {
  ALL_ACTIONS,
  ACTION_SCOPES,
  SYSTEM_ROLES,
  SINGLE_USER_PRINCIPAL,
} = require("./seeds/permissions");

async function main() {
  const settings = [
    { label: "multi_user_mode", value: "false" },
    { label: "logo_filename", value: "approofworkspace.png" },
  ];

  for (let setting of settings) {
    const existing = await prisma.system_settings.findUnique({
      where: { label: setting.label },
    });

    // Only create the setting if it doesn't already exist
    if (!existing) {
      await prisma.system_settings.create({
        data: setting,
      });
    }
  }

  // T-1 vocabulary/roles/grants — idempotent upserts mirroring migration
  // step 7a/5 (production gets them from the migration; this covers dev resets).
  const cat = (a) => a.split(".")[0].replace(/-(.)/g, (_, c) => c.toUpperCase());
  // #138: `scope` is written here, not left to the column default.
  //
  // The seed used to set only `category`, so on a database built by `db push` +
  // seed (no migrations) every action came out scope 'any' — including
  // `org.member`, whose whole point is that the engine REFUSES it against a
  // workspace resource. Migrated installs got the right value from migration
  // 102000, so the two deployment shapes disagreed and only the migrated one was
  // ever tested. Measured on both paths, not inferred.
  //
  // `update` carries scope too: a database seeded before this change already
  // holds the wrong value, and an upsert that only fixes new rows would leave it.
  for (const action of ALL_ACTIONS) {
    const scope = ACTION_SCOPES[action] ?? "any";
    await prisma.permissions.upsert({
      where: { action },
      create: { action, description: action, category: cat(action), scope },
      update: { category: cat(action), scope },
    });
  }

  const roleIdByName = {};
  for (const role of SYSTEM_ROLES) {
    const row = await prisma.roles.upsert({
      where: { orgId_scope_name: { orgId: 1, scope: role.scope, name: role.name } },
      create: { name: role.name, scope: role.scope, orgId: 1, isSystem: true },
      update: {},
    });
    roleIdByName[role.name] = row.id;
    for (const action of role.permissions) {
      await prisma.role_permissions.upsert({
        where: {
          role_id_permission_id: {
            role_id: row.id,
            permission_id: (
              await prisma.permissions.findUniqueOrThrow({ where: { action } })
            ).id,
          },
        },
        create: {
          role_id: row.id,
          permission_id: (
            await prisma.permissions.findUniqueOrThrow({ where: { action } })
          ).id,
        },
        update: {},
      });
    }
  }

  // compound-unique upsert cannot express workspace_id IS NULL in Prisma 5 — find-then-create
  const existingPrincipal = await prisma.principal_role_grants.findFirst({
    where: {
      orgId: 1,
      principal_type: SINGLE_USER_PRINCIPAL.principal_type,
      principal_id: SINGLE_USER_PRINCIPAL.principal_id,
      role_id: roleIdByName[SINGLE_USER_PRINCIPAL.role],
      workspace_id: null,
    },
  });
  if (!existingPrincipal) {
    await prisma.principal_role_grants.create({
      data: {
        orgId: 1,
        principal_type: SINGLE_USER_PRINCIPAL.principal_type,
        principal_id: SINGLE_USER_PRINCIPAL.principal_id,
        role_id: roleIdByName[SINGLE_USER_PRINCIPAL.role],
      },
    });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
