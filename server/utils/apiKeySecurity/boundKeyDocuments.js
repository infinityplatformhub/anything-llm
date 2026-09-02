// #41: a workspace-bound API key must not reach another workspace's documents.
//
// Document storage is one global namespace on disk: `viewLocalFiles()` walks
// `$STORAGE_DIR/documents` and never asks the database whose document it just read. The
// scope middleware cannot close this — these routes carry no workspace in the path, so
// there is nothing for `workspaceSlugParam` to bind against, and `validApiKey` therefore
// treats them as org-level questions. The narrowing has to happen where the answer is
// built, the same way `/v1/workspaces` narrows at its query (endpoints/api/workspace/index.js:154).
//
// PMO ruling: STRICT join. A bound key sees a document only when a `workspace_documents`
// row attaches it to that key's workspace. Documents with no row at all — uploaded but
// never attached — are a shared namespace, so they stay invisible to a bound key rather
// than being treated as "not yet anyone's". The write side of the same hole is closed by
// attaching uploads to the bound workspace immediately, so a bound key never uploads a
// document it then cannot see.

const prisma = require("../prisma");

/**
 * The bound workspace id for this request, or null for an unbound key or a session.
 * @returns {string|null}
 */
function boundWorkspaceId(response) {
  return response?.locals?.apiKeyContext?.workspaceId ?? null;
}

/** True when this request comes from a workspace-bound API key. */
const isBoundKeyRequest = (response) => boundWorkspaceId(response) !== null;

/**
 * The docpaths attached to the bound workspace.
 *
 * Fails CLOSED: an unreadable `workspace_documents` denies everything rather than
 * falling through to the full listing, because "the join failed" must never read as
 * "no restriction applies".
 *
 * @returns {Promise<Set<string>>} docpaths, or an empty set when nothing is attached
 */
async function boundDocpaths(response, db = prisma) {
  const workspaceId = boundWorkspaceId(response);
  if (workspaceId === null) return null; // unbound: no restriction
  try {
    const rows = await db.workspace_documents.findMany({
      where: { workspaceId: Number(workspaceId) },
      select: { docpath: true },
    });
    return new Set(rows.map((row) => row.docpath));
  } catch (error) {
    console.error(`[#41] bound-key document join failed: ${error.message}`);
    return new Set();
  }
}

/**
 * Narrows the `viewLocalFiles()` tree to the bound workspace.
 *
 * The tree is folder -> items, and an item's docpath is `${folder}/${item.name}` — the
 * same key `getPinnedWorkspacesByDocument` is given, and the same string stored in
 * `workspace_documents.docpath`. Folders left empty are dropped: a bound key learning
 * that "finance" exists but is empty for them is the folder listing leaking anyway.
 */
function narrowLocalFiles(localFiles, allowed) {
  if (!allowed) return localFiles;
  const items = (localFiles?.items ?? [])
    .map((folder) => ({
      ...folder,
      items: (folder.items ?? []).filter((doc) =>
        allowed.has(`${folder.name}/${doc.name}`)
      ),
    }))
    .filter((folder) => folder.items.length > 0);
  return { ...localFiles, items };
}

/** Narrows a `getDocumentsByFolder()` result in place of its `documents` array. */
function narrowFolderDocuments(folderName, documents, allowed) {
  if (!allowed) return documents;
  return (documents ?? []).filter((doc) =>
    allowed.has(`${folderName}/${doc.name}`)
  );
}

/**
 * Is this single document attached to the bound workspace?
 *
 * Takes the docpath rather than the document object because the route that needs it
 * (`GET /v1/document/:docName`) resolves by walking storage and gets back a name, not
 * a path — the caller composes the two.
 */
function docpathIsBound(docpath, allowed) {
  if (!allowed) return true;
  return allowed.has(docpath);
}

/**
 * The workspace slugs an upload should attach to.
 *
 * The write half of the strict join. A bound key that uploads without naming any
 * workspace would otherwise leave the document unattached — and an unattached document
 * is invisible to that same key under `boundDocpaths`, so it could upload a file and
 * then be told it does not exist. Attaching to the bound workspace is the only answer
 * that leaves no window between the two halves.
 *
 * `validateWorkspaceSlugQuery` has already refused any slug outside the binding by the
 * time this runs, so an explicit list from a bound key is exactly its own workspace and
 * is passed through untouched. An unbound key is untouched in every case.
 *
 * Never falls back to "attach to nothing" silently. Under the strict join an unattached
 * document is invisible to the very key that uploaded it and cannot be deleted through
 * these routes either — so a 200 saying `success: true` would report a working upload
 * that has actually produced an orphan the caller can neither see nor remove. The orphan
 * is left in place (deleting a file the caller may still want is the worse direction),
 * but the caller is told.
 *
 * @returns {Promise<{slugs: string, error: string|null}>} slugs in `uploadToWorkspace`'s
 *   comma-separated format, or an error the route must surface instead of a success.
 */
async function attachTargets(response, addToWorkspaces = "", db = prisma) {
  if (addToWorkspaces) return { slugs: addToWorkspaces, error: null };
  const workspaceId = boundWorkspaceId(response);
  if (workspaceId === null) return { slugs: addToWorkspaces, error: null };
  try {
    const workspace = await db.workspaces.findUnique({
      where: { id: Number(workspaceId) },
      select: { slug: true },
    });
    if (!workspace?.slug) {
      return {
        slugs: "",
        error:
          "Document was uploaded but not attached to a workspace: the workspace this key is bound to could not be resolved. The document is not visible to this key.",
      };
    }
    return { slugs: workspace.slug, error: null };
  } catch (error) {
    console.error(`[#41] bound-key upload attach failed: ${error.message}`);
    return {
      slugs: "",
      error:
        "Document was uploaded but not attached to a workspace. The document is not visible to this key.",
    };
  }
}

module.exports = {
  attachTargets,
  boundWorkspaceId,
  isBoundKeyRequest,
  boundDocpaths,
  narrowLocalFiles,
  narrowFolderDocuments,
  docpathIsBound,
};
