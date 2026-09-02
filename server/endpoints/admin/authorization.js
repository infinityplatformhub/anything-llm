// T-7 (#31): authorization diagnostics — "who can see this, and why".
//
// Gated on `access.diagnose`, which is deliberately NOT held by the org
// `member` role: the answer names every principal with access to a document,
// which is a map of who is interesting to attack.

const {
  explainDocumentAccess,
} = require("../../utils/authorization/explainAccess");
const {
  AuthorizationContractError,
  AuthorizationUnavailableError,
} = require("../../utils/authorization/errors");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");
const {
  requirePermission,
} = require("../../utils/middleware/requirePermission");
const { orgResource } = require("../../utils/middleware/resourceResolvers");

function adminAuthorizationEndpoints(app) {
  if (!app) return;

  app.get(
    "/admin/authorization/document/:documentId",
    [validatedRequest, requirePermission("access.diagnose", orgResource)],
    async (request, response) => {
      try {
        const documentId = Number(request.params.documentId);
        const action =
          typeof request.query?.action === "string"
            ? request.query.action
            : "document.read";

        const explanation = await explainDocumentAccess({
          documentId,
          action,
        });

        // Denial and absence read the same to the caller: a diagnostics route
        // that confirms which document ids exist is an enumeration oracle
        // (S-18). The gate above already decided they may ask at all.
        if (!explanation) return response.sendStatus(404);

        response.status(200).json(explanation);
      } catch (error) {
        if (error instanceof AuthorizationContractError)
          return response.status(400).json({ error: error.message });
        if (error instanceof AuthorizationUnavailableError)
          // 409, not 500: the answer was refused because it would have been
          // wrong, and retrying is the correct response.
          return response.status(409).json({ error: error.message });
        console.error(error.message, error);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { adminAuthorizationEndpoints };
