-- V9 (#61): chat history search over a user's own chats.
--
-- Three things happen here: a searchable projection of the assistant's answer,
-- the trigram indexes that make substring search survivable, and the composite
-- index the two pre-existing chat reads have been missing since the initial
-- schema.

-- 1. response_text — the assistant's answer as plain text.
--
-- `response` holds a JSON blob ({text, sources[], attachments[], ...}), so the
-- readable answer is `response::jsonb->>'text'` and the rest is retrieval
-- metadata: document names and paths the user never saw. Indexing the raw
-- column would make a search for a colleague's surname surface chats whose
-- SOURCES mention a file with that name — a false positive that is also a
-- disclosure. So the searchable text gets its own column.
--
-- A STORED GENERATED column would be tidier and is deliberately not used: it
-- evaluates the cast for every existing row at migration time and aborts the
-- whole migration on the first malformed value. Malformed values exist — the
-- read path documents them (convertToChatHistory skips records whose
-- `data.text` is not a string). A migration that cannot run on real data is
-- not a migration.
ALTER TABLE "workspace_chats" ADD COLUMN "response_text" TEXT;

-- Backfill under a validity guard. pg_input_is_valid (PG16+) tests the cast
-- without raising, so a row whose `response` is not valid JSON gets NULL and is
-- simply not searchable, rather than taking the migration down with it. A row
-- that already fails to render in the UI does not need to be findable.
UPDATE "workspace_chats"
   SET "response_text" = ("response"::jsonb ->> 'text')
 WHERE pg_input_is_valid("response", 'jsonb')
   AND jsonb_typeof("response"::jsonb -> 'text') = 'string';

-- 2. Trigram search.
--
-- Trigram rather than tsvector, and the reason is Thai, not performance: Thai
-- does not put spaces between words, Postgres has no Thai segmenter, and
-- to_tsvector('simple', 'ค้นหาประวัติแชท') therefore produces ONE lexeme
-- covering the whole phrase. A query for 'ประวัติ' would match nothing. A
-- full-text index here would be an index that never fires for the product's
-- primary language — worse than no index, because it looks like search.
--
-- Trigrams index character triples, so substring matching works identically in
-- Thai and English. What is given up: ranking, stemming, phrase proximity.
-- Results order by recency, not by match quality (see recon §3).
--
-- The privilege this needs is the one the deployment already exercises for
-- pgvector: utils/vectorDbProviders/pgvector/index.js:49 runs
-- `CREATE EXTENSION IF NOT EXISTS vector;` against the operator's database and
-- pgvector/SETUP.md documents it as a setup step.

-- Pinned to `public`, not left to the session's search_path.
--
-- CREATE EXTENSION with no SCHEMA installs into the FIRST schema on the
-- search_path, which for a Prisma connection carrying `?schema=<name>` is that
-- per-connection schema. The extension then lives somewhere the tables do not,
-- `gin_trgm_ops` is not resolvable from `public`, and the very next statement
-- fails with 42704 -- taking the migration down and leaving the database in the
-- failed-migration state that blocks every later one. Several suites in this
-- repo connect exactly that way (samlRoutesHttp, keyScopeCeiling, purge.postgres
-- and others all set ?schema=), so this is the ordinary case here, not an exotic
-- one.
--
-- IF NOT EXISTS is schema-blind: it matches an installation in ANY schema, so a
-- database that already has pg_trgm somewhere unhelpful is not repaired by
-- re-running this. Explicit SCHEMA public is what makes a fresh database land it
-- where the indexes below can see it.
--
-- The privilege this needs is the one the deployment already exercises for
-- pgvector (see above).
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;

CREATE INDEX "workspace_chats_prompt_trgm"
    ON "workspace_chats" USING gin ("prompt" public.gin_trgm_ops);

CREATE INDEX "workspace_chats_response_text_trgm"
    ON "workspace_chats" USING gin ("response_text" public.gin_trgm_ops);

-- 3. The composite index the existing reads never had.
--
-- workspace_chats has carried no index but its primary key since the initial
-- schema, while forWorkspaceByUser and the thread read have always filtered on
-- (user_id, workspaceId). Not V9's bug, but this is the migration that looks at
-- this table's access patterns.
CREATE INDEX "workspace_chats_user_workspace_idx"
    ON "workspace_chats" ("user_id", "workspaceId", "id" DESC);
