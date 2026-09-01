-- T-1 (#17) post-migration reports — run standalone (psql) after deploy.
-- Migration artifact per DoD (also emitted as RAISE NOTICE during migrate).
-- dedupe_key expression must match migration step 3 exactly.

-- Report 1: manager downgrade list (R4/A-R4 — the one-way step's audit trail)
-- workspaces_access_lost = total - kept (always >= 0).
SELECT u.id            AS user_id,
       u.username,
       u.role          AS legacy_role,
       count(w.id) FILTER (WHERE w.created_by = u.id) AS workspaces_kept_as_owner,
       (SELECT count(*) FROM workspaces)              AS workspaces_total,
       (SELECT count(*) FROM workspaces) - count(w.id) FILTER (WHERE w.created_by = u.id)
                                                      AS workspaces_access_lost
FROM users u LEFT JOIN workspaces w ON w.created_by = u.id
WHERE u.role = 'manager'
GROUP BY u.id, u.username, u.role
ORDER BY u.id;

-- Report 2: dedupe groups with conflicts (N>1 members or differing metadata across members)
SELECT COALESCE(NULLIF(docpath, ''), 'orphan:' || "docId") AS dedupe_key,
       count(*)                                   AS member_rows,
       count(DISTINCT filename)                   AS distinct_filenames,
       count(DISTINCT COALESCE(metadata, '{}'))   AS distinct_metadata
FROM workspace_documents
GROUP BY 1
HAVING count(*) > 1
ORDER BY count(*) DESC, 1;

-- Report 3: created_by nulls (workspaces with no membership row — get no owner)
SELECT w.id, w.name, w.slug
FROM workspaces w
WHERE w.created_by IS NULL
ORDER BY w.id;

-- Report 4 (pre-flight, not a migration artifact): empty docpath rows — known before grouping.
-- docpath is NOT NULL; only '' is possible.
SELECT count(*) AS empty_docpath_rows FROM workspace_documents WHERE docpath = '';
