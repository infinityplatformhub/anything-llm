const { SystemSettings } = require("../models/systemSettings");
const { DatabaseAuthorizationEngine } = require("./authorization/engine");
const { orgResource } = require("./middleware/resourceResolvers");

const authorizationEngine = new DatabaseAuthorizationEngine();

// These match settings written by ManagerRoute pages in the frontend.
const managerAllowedFields = Object.freeze([
  "custom_app_name",
  "footer_data",
  "support_email",
  "meta_page_title",
  "meta_page_favicon",
]);

async function narrowManagerSystemPreferences(actor, updates) {
  const unrestricted = await authorizationEngine.authorize({
    actor,
    action: "system.write",
    resource: await orgResource(),
  });
  if (unrestricted.allowed) return { updates };

  const forbiddenKeys = Object.keys(updates).filter(
    (key) =>
      SystemSettings.supportedFields.includes(key) &&
      !managerAllowedFields.includes(key)
  );
  if (forbiddenKeys.length > 0) {
    return {
      refusal: {
        success: false,
        error: `Forbidden setting keys: ${forbiddenKeys.join(", ")}`,
        code: "forbidden_keys",
        forbiddenKeys,
        forbiddenKeyCount: forbiddenKeys.length,
      },
    };
  }

  return {
    updates: Object.fromEntries(
      Object.entries(updates).filter(([key]) =>
        managerAllowedFields.includes(key)
      )
    ),
  };
}

module.exports = { managerAllowedFields, narrowManagerSystemPreferences };
