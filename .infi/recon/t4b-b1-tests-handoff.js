test("S-9 ingress: API-key scope cannot exceed creator permission", async () => {
  const creator = { type: "user", id: "4201", orgId: 1 };
  await prisma.users.create({
    data: { id: 4201, username: `limited-${dbSuffix}`, password: "unused" },
  });
  await repository.grantRole({
    actor: require("../../../utils/authorization/actorResolver")
      .SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: creator.id,
    roleId: roles.viewer.id,
    workspaceId: workspaceA.id,
    db: prisma,
  });
  const key = await prisma.api_keys.create({
    data: {
      name: "over-scoped",
      secretDigest: Buffer.from(crypto.randomBytes(32)),
      keyPrefix: `t4a${dbSuffix}`,
      scopes: JSON.stringify(["workspace.write"]),
      workspaceId: workspaceA.id,
      createdBy: Number(creator.id),
    },
  });
  await repository.grantRole({
    actor: require("../../../utils/authorization/actorResolver")
      .SERVICE_PRINCIPALS.singleUser,
    principalType: "service",
    principalId: `api-key:${key.id}`,
    roleId: roles.owner.id,
    workspaceId: workspaceA.id,
    db: prisma,
  });
  const decision = await engine.authorize({
    actor: {
      type: "service",
      id: `api-key:${key.id}`,
      orgId: 1,
      attributes: { scopes: ["workspace.write"] },
    },
    action: "workspace.write",
    resource: {
      type: "workspace",
      id: String(workspaceA.id),
      orgId: 1,
      workspaceId: workspaceA.id,
    },
  });
  expect(decision.allowed).toBe(false);
});

test("B-1: API key is allowed when creator holds grant and scope permits action", async () => {
  const creatorId = 4202;
  await prisma.users.create({
    data: {
      id: creatorId,
      username: `allowed-${dbSuffix}`,
      password: "unused",
    },
  });
  await repository.grantRole({
    actor: require("../../../utils/authorization/actorResolver")
      .SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: String(creatorId),
    roleId: roles.viewer.id,
    workspaceId: workspaceA.id,
    db: prisma,
  });
  const key = await prisma.api_keys.create({
    data: {
      name: "valid",
      secretDigest: Buffer.from(crypto.randomBytes(32)),
      keyPrefix: `ok${dbSuffix}`,
      scopes: JSON.stringify(["document.read"]),
      workspaceId: workspaceA.id,
      createdBy: creatorId,
    },
  });
  const decision = await engine.authorize({
    actor: {
      type: "service",
      id: `api-key:${key.id}`,
      orgId: 1,
      attributes: { scopes: ["document.read"] },
    },
    action: "document.read",
    resource: {
      type: "document",
      id: "1",
      orgId: 1,
      workspaceId: workspaceA.id,
    },
  });
  expect(decision.allowed).toBe(true);
});

