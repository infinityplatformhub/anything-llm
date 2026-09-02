// V9 (#61): chat history search — the row-level half of the ACL.
//
// The gate (requirePermission("chat.read", workspaceBySlug)) is proven for chat
// routes in routeWiring.test.js; this suite proves the half the engine does NOT
// do. There is no documentFilter for workspace_chats, so `user_id` is enforced
// by the model, and the RED here is the leak that appears the moment that
// predicate is dropped: user B's chat in user A's results.
//
// Real Postgres, real migrations (the trigram indexes and response_text are the
// thing under test), real route stack.
process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "v9-chat-search-")
  );
const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `v9_search_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

const ALICE = { id: 6101, role: "default", username: `v9-alice-${dbSuffix}` };
const BOB = { id: 6102, role: "default", username: `v9-bob-${dbSuffix}` };
// An admin holds chat.read_others. V9 must not let that widen search.
const CAROL = { id: 6103, role: "admin", username: `v9-carol-${dbSuffix}` };

// The route reads the session user; each test names who is calling.
let currentUser = ALICE;

let prisma;
let WorkspaceChats;
let workspace;
let thread;
let server;
let baseUrl;

jest.mock("../../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, response, next) => {
    response.locals.multiUserMode = true;
    response.locals.user = global.__V9_CURRENT_USER__;
    next();
  },
}));
jest.mock("../../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn() },
}));
jest.mock("../../../utils/files/multer", () => ({
  handleFileUpload: (_request, _response, next) => next(),
}));

const asUser = (user) => {
  currentUser = user;
  global.__V9_CURRENT_USER__ = user;
};

const search = async (query, extra = "") => {
  const response = await fetch(
    `${baseUrl}/workspace/${workspace.slug}/chats/search?q=${encodeURIComponent(query)}${extra}`
  );
  const body = response.status === 200 ? await response.json() : null;
  return { status: response.status, body };
};

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error(
      "V9 chat-search tests require DATABASE_URL pointing at PostgreSQL"
    );
  }
  const admin = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${testDb}"`);
  await admin.$disconnect();
  execSync(`npx prisma migrate deploy --schema ${SCHEMA}`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  execSync("node prisma/seed.js", {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });

  process.env.DATABASE_URL = testUrl;
  jest.resetModules();
  prisma = require("../../../utils/prisma");
  ({ WorkspaceChats } = require("../../../models/workspaceChats"));
  const {
    syncWorkspaceMembershipGrant,
  } = require("../../../utils/authorization/legacyRoleGrants");
  const {
    SERVICE_PRINCIPALS,
  } = require("../../../utils/authorization/actorResolver");

  const {
    syncLegacyRoleGrant,
  } = require("../../../utils/authorization/legacyRoleGrants");
  for (const user of [ALICE, BOB, CAROL]) {
    await prisma.users.create({
      data: {
        id: user.id,
        username: user.username,
        password: "unused",
        role: user.role,
      },
    });
    // A raw users insert carries no grant, so CAROL would hold no
    // chat.read_others and the test that says the permission does not widen
    // search would pass for the wrong reason. Grant the way production does.
    await syncLegacyRoleGrant(user, { db: prisma });
  }

  workspace = await prisma.workspaces.create({
    data: { name: "V9", slug: `v9-ws-${dbSuffix}`, created_by: ALICE.id },
  });
  thread = await prisma.workspace_threads.create({
    data: {
      name: "V9 thread",
      slug: `v9-thread-${dbSuffix}`,
      workspace_id: workspace.id,
      user_id: ALICE.id,
    },
  });

  // Membership through the production path — a raw workspace_users insert leaves
  // the row without its grant, and every ALLOW below would then be the only thing
  // catching a gate that never ran (§7.7).
  const ownerRole = await prisma.roles.findFirstOrThrow({
    where: { name: "owner", scope: "workspace" },
  });
  for (const user of [ALICE, BOB, CAROL]) {
    await prisma.workspace_users.create({
      data: {
        user_id: user.id,
        workspace_id: workspace.id,
        role_id: ownerRole.id,
      },
    });
    await syncWorkspaceMembershipGrant({
      userId: user.id,
      workspaceId: workspace.id,
      actor: SERVICE_PRINCIPALS.singleUser,
      db: prisma,
    });
  }

  const express = require("express");
  const app = express();
  app.use(express.json());
  require("../../../endpoints/workspaces").workspaceEndpoints(app);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  asUser(ALICE);
}, 300_000);

afterAll(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  if (prisma) await prisma.$disconnect();
  process.env.DATABASE_URL = baseDatabaseUrl;
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({
      datasources: { db: { url: baseDatabaseUrl } },
    });
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`
    );
    await admin.$disconnect();
  }
}, 60_000);

// The word both users' chats share, so a leak is visible as a row count.
const SHARED_TERM = "quarterly-forecast";

const seedChat = async ({ user, prompt, text, threadId = null, ...rest }) =>
  WorkspaceChats.new({
    workspaceId: workspace.id,
    prompt,
    response: { text },
    user: { id: user.id },
    threadId,
    ...rest,
  });

describe("V9 chat search: a user searches only their own chats", () => {
  beforeAll(async () => {
    await prisma.workspace_chats.deleteMany({});
    await seedChat({
      user: ALICE,
      prompt: `what is the ${SHARED_TERM}?`,
      text: "alice answer",
      threadId: thread.id,
    });
    await seedChat({
      user: BOB,
      prompt: `bob asked about the ${SHARED_TERM} too`,
      text: "bob answer",
    });
  });

  // THE RED. Removing `user_id` from searchForUser's where clause makes this
  // fail by returning two rows, and the failure names the leaked owner rather
  // than a crash or a 500 (§7.9).
  test("Alice's results never contain a chat owned by Bob", async () => {
    asUser(ALICE);
    const { status, body } = await search(SHARED_TERM);
    expect(status).toBe(200);

    const ownerIds = await Promise.all(
      body.results.map(async ({ chatId }) => {
        const row = await prisma.workspace_chats.findUnique({
          where: { id: chatId },
          select: { user_id: true },
        });
        return row.user_id;
      })
    );
    expect(ownerIds).toEqual([ALICE.id]);
    expect(body.results).toHaveLength(1);
  });

  test("Bob searching the same term sees his own chat and not Alice's", async () => {
    asUser(BOB);
    const { body } = await search(SHARED_TERM);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].prompt).toContain("bob asked");
  });

  // chat.read_others is what lets an admin read the whole instance's history
  // (system.js:1261). V9 is scoped to "แชทตัวเอง", so it must not widen search
  // — cross-user search is V10, with its own leak tests.
  test("an admin holding chat.read_others still sees only their own chats", async () => {
    asUser(CAROL);
    const engine =
      new (require("../../../utils/authorization/engine").DatabaseAuthorizationEngine)(
        { db: prisma }
      );
    const decision = await engine.authorize({
      actor: { type: "user", id: String(CAROL.id), orgId: 1 },
      action: "chat.read_others",
      resource: { type: "org", id: "1", orgId: 1, workspaceId: null },
    });
    // Guard the premise: if Carol does not actually hold the permission, the
    // assertion below would pass for the wrong reason.
    expect(decision.allowed).toBe(true);

    const { body } = await search(SHARED_TERM);
    expect(body.results).toEqual([]);
  });
});

describe("V9 chat search: what is searchable", () => {
  beforeAll(async () => {
    await prisma.workspace_chats.deleteMany({});
    asUser(ALICE);
  });

  test("matches the assistant's answer, not just the prompt", async () => {
    await seedChat({
      user: ALICE,
      prompt: "unrelated question",
      text: "the answer mentions ปลาวาฬสีน้ำเงิน explicitly",
    });
    const { body } = await search("ปลาวาฬ");
    expect(body.results).toHaveLength(1);
    expect(body.results[0].response).toContain("ปลาวาฬสีน้ำเงิน");
  });

  // Thai has no word boundaries, so a mid-word substring is the ordinary case
  // rather than an edge one — this is why the index is trigram and not tsvector
  // (recon §3). A tsvector index would return nothing here.
  test("a mid-word Thai substring matches", async () => {
    await prisma.workspace_chats.deleteMany({});
    await seedChat({
      user: ALICE,
      prompt: "ช่วยสรุปประวัติการสนทนาให้หน่อย",
      text: "สรุปแล้ว",
    });
    const { body } = await search("ประวัติ");
    expect(body.results).toHaveLength(1);
  });

  // Raw `response` holds sources and attachments. Indexing it would make a
  // search match document names the user never saw — both a false positive and
  // a disclosure (recon §4). Only response.text is searchable.
  test("retrieval metadata inside response is NOT searchable", async () => {
    await prisma.workspace_chats.deleteMany({});
    await seedChat({
      user: ALICE,
      prompt: "summarize it",
      text: "here is the summary",
      // The model stringifies this whole object into `response`; only `.text`
      // reaches response_text.
    });
    await prisma.workspace_chats.updateMany({
      data: {
        response: JSON.stringify({
          text: "here is the summary",
          sources: [{ title: "board-compensation-2026.pdf" }],
        }),
      },
    });
    const { body } = await search("board-compensation");
    expect(body.results).toEqual([]);
  });

  test("api-session chats and excluded chats never appear", async () => {
    await prisma.workspace_chats.deleteMany({});
    await seedChat({
      user: ALICE,
      prompt: "visible needle here",
      text: "ok",
    });
    await prisma.workspace_chats.create({
      data: {
        workspaceId: workspace.id,
        prompt: "api needle here",
        response: JSON.stringify({ text: "ok" }),
        response_text: "ok",
        user_id: ALICE.id,
        api_session_id: "session-1",
      },
    });
    await prisma.workspace_chats.create({
      data: {
        workspaceId: workspace.id,
        prompt: "excluded needle here",
        response: JSON.stringify({ text: "ok" }),
        response_text: "ok",
        user_id: ALICE.id,
        include: false,
      },
    });
    const { body } = await search("needle");
    expect(body.results).toHaveLength(1);
    expect(body.results[0].prompt).toContain("visible");
  });

  test("chats in another workspace are not reachable through this workspace", async () => {
    await prisma.workspace_chats.deleteMany({});
    const other = await prisma.workspaces.create({
      data: { name: "other", slug: `v9-other-${dbSuffix}` },
    });
    await prisma.workspace_chats.create({
      data: {
        workspaceId: other.id,
        prompt: "elsewhere needle",
        response: JSON.stringify({ text: "ok" }),
        response_text: "ok",
        user_id: ALICE.id,
      },
    });
    const { body } = await search("elsewhere");
    expect(body.results).toEqual([]);
  });
});

describe("V9 chat search: an edited chat is searched as it now reads", () => {
  // Techlead-1 FINDING-1. `response` is a JSON string and response_text is its
  // projection, so an edit that writes one and not the other leaves the row
  // findable by text the user deleted -- and the search route hands back the
  // old wording, because it reads response_text.
  //
  // Both update-chat routes go through WorkspaceChats._update, which is where
  // the derivation now lives; these tests drive the model the way those routes
  // do.
  beforeAll(async () => {
    await prisma.workspace_chats.deleteMany({});
    asUser(ALICE);
  });

  const OLD = "zygomorphic";
  const NEW = "actinomorphic";

  test("editing the answer makes the old wording unfindable and the new wording findable", async () => {
    await prisma.workspace_chats.deleteMany({});
    await seedChat({
      user: ALICE,
      prompt: "an unremarkable question",
      text: `the answer mentions ${OLD}`,
    });
    expect((await search(OLD)).body.results).toHaveLength(1);

    // Exactly what endpoints/workspaces.js:654 and workspaceThreads.js:260 do.
    const [chat] = await prisma.workspace_chats.findMany({ take: 1 });
    const parsed = JSON.parse(chat.response);
    await WorkspaceChats._update(chat.id, {
      response: JSON.stringify({ ...parsed, text: `the answer mentions ${NEW}` }),
    });

    expect((await search(OLD)).body.results).toEqual([]);
    const hits = (await search(NEW)).body.results;
    expect(hits).toHaveLength(1);
    // The route returns response_text, so a stale projection shows up as the
    // old wording being handed back even once the search itself is fixed.
    expect(hits[0].response).toBe(`the answer mentions ${NEW}`);
  });

  test("an update that does not touch response leaves the searchable text alone", async () => {
    await prisma.workspace_chats.deleteMany({});
    await seedChat({
      user: ALICE,
      prompt: "another question",
      text: `still mentions ${OLD}`,
    });
    const [chat] = await prisma.workspace_chats.findMany({ take: 1 });

    // Flipping feedbackScore must not rewrite the row's searchable text as a
    // side effect -- the derivation is keyed on `response` being present.
    await WorkspaceChats._update(chat.id, { feedbackScore: true });
    expect((await search(OLD)).body.results).toHaveLength(1);
  });

  // QA-3 F2: agent chat history overwrites an existing row through upsert
  // (utils/agents/aibitat/plugins/chat-history.js), which is a `response` write
  // like any other.
  test("upsert overwriting a response updates the searchable text", async () => {
    await prisma.workspace_chats.deleteMany({});
    const created = await seedChat({
      user: ALICE,
      prompt: "agent question",
      text: `agent said ${OLD}`,
    });
    expect((await search(OLD)).body.results).toHaveLength(1);

    await WorkspaceChats.upsert(created.chat.id, {
      workspaceId: workspace.id,
      prompt: "agent question",
      response: { text: `agent said ${NEW}` },
      user: { id: ALICE.id },
      threadId: null,
      include: true,
      apiSessionId: null,
    });

    expect((await search(OLD)).body.results).toEqual([]);
    expect((await search(NEW)).body.results).toHaveLength(1);
  });

  // QA-3 F3: the import path. bulkCreate is handed rows whose `response` is
  // already a JSON string, so an imported chat would arrive unsearchable.
  test("bulkCreate imports arrive searchable", async () => {
    await prisma.workspace_chats.deleteMany({});
    await WorkspaceChats.bulkCreate([
      {
        workspaceId: workspace.id,
        prompt: "imported question",
        response: JSON.stringify({ text: `imported answer about ${NEW}` }),
        user_id: ALICE.id,
        include: true,
      },
    ]);

    const hits = (await search(NEW)).body.results;
    expect(hits).toHaveLength(1);
    expect(hits[0].response).toBe(`imported answer about ${NEW}`);
  });

  // Every write path that sets `response` must set response_text. A new one
  // added later would pass the four tests above (they name the paths that exist
  // today) and still ship the bug, so this reads the model itself.
  test("no write path sets response without deriving response_text", async () => {
    // The behaviour tests above name the write paths that exist today; a fifth
    // added later would pass all of them and still ship the bug. So read the
    // model itself.
    //
    // Split by the FUNCTION that wraps each write, not by a character window
    // around the prisma call: upsert builds its payload a dozen lines above the
    // call, so a fixed window starting at the call misses it entirely and a
    // mutant that drops response_text from upsert survives (Techlead-1 NIT-1).
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "../../../models/workspaceChats.js"),
      "utf8"
    );

    // Model methods are `name: async function (` / `name: function (` at one
    // indent level; slicing between them gives each method's whole body.
    const starts = [
      ...source.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*): (?:async )?function/gm),
    ];
    expect(starts.length).toBeGreaterThan(5);

    const methods = starts.map((match, index) => ({
      name: match[1],
      body: source.slice(
        match.index,
        index + 1 < starts.length ? starts[index + 1].index : source.length
      ),
    }));

    // Every method that performs a prisma write AND mentions `response` has to
    // mention the derivation too, somewhere in that same method.
    const writers = methods.filter(
      ({ body }) =>
        /prisma\.workspace_chats\.(create|update|upsert)/.test(body) &&
        /\bresponse\b/.test(body)
    );
    // Guard the guard: a pattern that matches nothing would make this vacuous.
    // new, _update, upsert, bulkCreate.
    expect(writers.map(({ name }) => name).sort()).toEqual([
      "_update",
      "bulkCreate",
      "new",
      "upsert",
    ]);

    const offenders = writers
      .filter(
        ({ body }) =>
          !/response_text|withResponseTextFrom|responseTextOf/.test(body)
      )
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  test("an edit to a response whose text is not a string stores NULL, not a coerced value", async () => {
    await prisma.workspace_chats.deleteMany({});
    await seedChat({ user: ALICE, prompt: "third question", text: "findable" });
    const [chat] = await prisma.workspace_chats.findMany({ take: 1 });

    await WorkspaceChats._update(chat.id, {
      response: JSON.stringify({ text: { nested: "object" } }),
    });
    const after = await prisma.workspace_chats.findUnique({
      where: { id: chat.id },
    });
    expect(after.response_text).toBeNull();
    // Not "[object Object]" -- a row that cannot be rendered is not findable.
    expect((await search("object")).body.results).toEqual([]);
  });
});

describe("V9 chat search: the trigram indexes serve the search predicate", () => {
  // Ruling Q5 said: assert the plan, not the clock, because a wall-clock
  // assertion in CI is a flake generator.
  //
  // Measured while writing this, on the real schema: at 10k rows the planner
  // picks a Seq Scan (cost 393) and is RIGHT to -- the whole table is 56kB and
  // reading it beats two bitmap builds. It switches to BitmapOr over both
  // trigram indexes somewhere before 100k. So "the plan contains Index Scan"
  // is not a property of the schema at the DoD's ten thousand messages; it is
  // a property of table size, bloat and current statistics. Asserting it would
  // be the flake Q5 set out to avoid, one level down.
  //
  // What IS deterministic, and what the regressions actually look like, is
  // whether these indexes can serve this predicate at all. A predicate change,
  // a dropped extension, an operator class that stops resolving, a column
  // renamed out from under the index -- each makes the index unusable, and
  // enable_seqscan=off exposes that immediately regardless of table size.
  beforeAll(async () => {
    await prisma.workspace_chats.deleteMany({});
    asUser(ALICE);
    const rows = [];
    for (let index = 0; index < 500; index += 1) {
      rows.push({
        workspaceId: workspace.id,
        prompt: `filler row ${index} about assorted unremarkable topics`,
        response: JSON.stringify({ text: `filler answer ${index}` }),
        response_text: `filler answer ${index}`,
        user_id: ALICE.id,
      });
    }
    await prisma.workspace_chats.createMany({ data: rows });
    await prisma.$executeRawUnsafe(`ANALYZE "workspace_chats"`);
  }, 120_000);

  // One assertion per column. The combined OR predicate is not a stable target:
  // with both trigram indexes available the planner may still reach the rows
  // through the composite (user_id, workspaceId) index and filter, which is a
  // perfectly good plan and says nothing about whether the trigram index on the
  // OTHER column is sound. Asking each column its own question is the version
  // that fails only when something is actually broken.
  test.each([
    ["prompt", "workspace_chats_prompt_trgm"],
    ["response_text", "workspace_chats_response_text_trgm"],
  ])(
    "the trigram index on %s can serve an ILIKE substring match",
    async (column, indexName) => {
      // enable_seqscan=off does not force an unusable index into a plan -- it
      // raises the cost of scanning, and the planner still refuses an index
      // that cannot answer the predicate. An index scan here therefore means
      // the index genuinely covers this query shape.
      //
      // SET LOCAL only lives inside a transaction; outside one it is a silent
      // no-op and the EXPLAIN would return the ordinary plan while the test
      // looked like it had forced something. Hence $transaction.
      const plan = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
        return tx.$queryRawUnsafe(
          `EXPLAIN (FORMAT JSON)
           SELECT id FROM "workspace_chats" WHERE "${column}" ILIKE $1`,
          "%pterodactyl%"
        );
      });
      const rendered = JSON.stringify(plan);

      expect(rendered).toContain(indexName);
      expect(rendered).toMatch(/Bitmap Index Scan|Index Scan/);
    }
  );

  test("the trigram operator class resolves from the search path", async () => {
    // The defect this pins really happened: CREATE EXTENSION without SCHEMA put
    // pg_trgm in a per-connection schema, gin_trgm_ops stopped resolving from
    // public, and the migration died with 42704. A connection that sets
    // ?schema= is the ordinary case in this repo's test suite.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT n.nspname AS schema
         FROM pg_extension e
         JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname = 'pg_trgm'`
    );
    expect(rows).toEqual([{ schema: "public" }]);
  });

  test("a search over ten thousand of the caller's own messages returns the right rows", async () => {
    // The DoD's size, asserted for CORRECTNESS rather than for a duration:
    // at this volume the needle is still found, and still only in the caller's
    // own chats. Timing is recorded in the ledger as evidence, not asserted
    // here -- see the note at the top of this block.
    const NEEDLE = "pterodactyl";
    const rows = [];
    for (let index = 0; index < 9_500; index += 1) {
      rows.push({
        workspaceId: workspace.id,
        prompt: `bulk row ${index} of ordinary conversation`,
        response: JSON.stringify({ text: `bulk answer ${index}` }),
        response_text: `bulk answer ${index}`,
        user_id: ALICE.id,
      });
    }
    await prisma.workspace_chats.createMany({ data: rows });
    await seedChat({
      user: ALICE,
      prompt: `the one about the ${NEEDLE}`,
      text: "found it",
    });
    // Bob's chat carries the same needle: the row filter must still hold at
    // volume, not only on the three-row fixtures above.
    await seedChat({
      user: BOB,
      prompt: `bob also mentions the ${NEEDLE}`,
      text: "bob answer",
    });
    await prisma.$executeRawUnsafe(`ANALYZE "workspace_chats"`);

    asUser(ALICE);
    const { body } = await search(NEEDLE);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].prompt).toContain("the one about");
  }, 180_000);
});

describe("V9 chat search: input handling", () => {
  beforeAll(async () => {
    await prisma.workspace_chats.deleteMany({});
    asUser(ALICE);
  });

  test.each([
    ["empty", ""],
    ["one character", "a"],
    ["whitespace that trims to nothing", "   "],
    ["over 200 characters", "x".repeat(201)],
  ])("rejects a query that is %s with 400", async (_label, query) => {
    const { status } = await search(query);
    expect(status).toBe(400);
  });

  test("a LIKE wildcard is searched as text, not as a wildcard", async () => {
    await prisma.workspace_chats.deleteMany({});
    await seedChat({ user: ALICE, prompt: "margin was 100% this year", text: "ok" });
    await seedChat({ user: ALICE, prompt: "no percentage here", text: "ok" });

    // Unescaped, "100%" would still match only the first row, but "%" alone —
    // and "_" — would match everything. Prove the metacharacter is literal.
    const { body: underscore } = await search("_o");
    expect(underscore.results).toEqual([]);

    const { body: percent } = await search("00%");
    expect(percent.results).toHaveLength(1);
  });

  test("a malformed cursor is refused rather than silently restarting", async () => {
    const { status } = await search("needle", "&cursor=abc");
    expect(status).toBe(400);
  });
});

describe("V9 chat search: paging and thread attribution", () => {
  beforeAll(async () => {
    await prisma.workspace_chats.deleteMany({});
    asUser(ALICE);
  });

  test("results carry the thread slug, and a default-thread chat carries null", async () => {
    await prisma.workspace_chats.deleteMany({});
    await seedChat({
      user: ALICE,
      prompt: "threaded anchorword",
      text: "ok",
      threadId: thread.id,
    });
    await seedChat({ user: ALICE, prompt: "default anchorword", text: "ok" });

    const { body } = await search("anchorword");
    const bySlug = Object.fromEntries(
      body.results.map((result) => [result.prompt, result.threadSlug])
    );
    expect(bySlug["threaded anchorword"]).toBe(thread.slug);
    expect(bySlug["default anchorword"]).toBeNull();
  });

  test("a full page hands back a cursor that walks to the next page without overlap", async () => {
    await prisma.workspace_chats.deleteMany({});
    for (let index = 0; index < 55; index += 1) {
      await seedChat({
        user: ALICE,
        prompt: `pagingword entry ${index}`,
        text: "ok",
      });
    }

    const first = await search("pagingword");
    expect(first.body.results).toHaveLength(50);
    expect(first.body.nextCursor).toBe(
      first.body.results[first.body.results.length - 1].chatId
    );

    const second = await search(
      "pagingword",
      `&cursor=${first.body.nextCursor}`
    );
    expect(second.body.results).toHaveLength(5);
    // A short page is the end of the walk.
    expect(second.body.nextCursor).toBeNull();

    const firstIds = first.body.results.map(({ chatId }) => chatId);
    const secondIds = second.body.results.map(({ chatId }) => chatId);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    // Newest first, so page two is strictly older than page one.
    expect(Math.min(...firstIds)).toBeGreaterThan(Math.max(...secondIds));
  });
});
