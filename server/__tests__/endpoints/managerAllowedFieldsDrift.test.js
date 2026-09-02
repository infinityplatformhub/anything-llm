const fs = require("fs");
const path = require("path");
const { SystemSettings } = require("../../models/systemSettings");
const {
  managerAllowedFields,
  narrowManagerSystemPreferences,
} = require("../../utils/managerSystemPreferences");

const managerComponents = [
  "CustomAppName/index.jsx",
  "FooterCustomization/index.jsx",
  "SupportEmail/index.jsx",
  "CustomSiteSettings/index.jsx",
];

const nonManagerCallers = {
  "components/WorkspaceChat/ChatContainer/MemoriesSidebar/PersonalizationToggle/index.jsx":
    "memory controls are admin-only in MemoriesContext",
  "components/WorkspaceChat/ChatContainer/PromptInput/ToolsMenu/Tabs/AgentSkills/useAgentSkillsState.js":
    "agent skill settings are admin-only",
  "components/WorkspaceChat/ChatContainer/PromptInput/ToolsMenu/Tabs/AgentSkills/useSubSkillPreferences.js":
    "agent sub-skill settings are admin-only",
  "pages/Admin/Agents/AgentSkillSettings/AgentClarifyingQuestions.jsx":
    "admin settings page",
  "pages/Admin/Agents/index.jsx": "admin settings page",
  "pages/GeneralSettings/EmbeddingTextSplitterPreference/index.jsx":
    "text splitter control is admin-only",
  "pages/WorkspaceSettings/AgentConfig/index.jsx":
    "workspace agent configuration is admin-only",
};

/**
 * Whether a file CALLS `Admin.updateSystemPreferences`, as opposed to merely mentioning it.
 *
 * The scan used to be `source.includes("updateSystemPreferences(")`, which cannot tell code
 * from prose. #40 task 4 added two files that explain in a COMMENT which server gate applies to
 * that call — "`Admin.updateSystemPreferences({memory_enabled})`, which the server gates with
 * requirePermission('settings.write')" — and the sweep reported both as unclassified callers.
 *
 * Allowlisting them would have been the wrong fix twice over: it would record a false claim
 * (they are not callers), and it would leave the next accurate comment failing the same way,
 * which teaches people to delete the comment rather than write it. A comment naming the API it
 * is about is exactly what a reader needs.
 *
 * Line comments are stripped before matching. Block comments and strings are NOT handled: this
 * is a heuristic over source text, not a parser, and every real call site in this repo is a
 * plain statement. A false POSITIVE fails loudly here, which is the safe direction — a caller
 * wrongly listed gets noticed; one wrongly skipped does not.
 */
function callsUpdateSystemPreferences(source) {
  return source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n")
    .includes("updateSystemPreferences(");
}

function writtenFields(source) {
  return [
    ...source.matchAll(/Admin\.updateSystemPreferences\(\{([\s\S]*?)\}\)/g),
  ]
    .flatMap(([, body]) => [
      ...body.matchAll(/^\s*([a-z][a-z0-9_]*)\s*(?::|,)/gm),
    ])
    .map(([, field]) => field);
}

describe("issue 78 manager allowed fields drift", () => {
  it("matches fields written by manager-reachable settings components", async () => {
    const componentsDir = path.resolve(
      __dirname,
      "../../../frontend/src/pages/GeneralSettings/Settings/components"
    );
    const frontendFields = managerComponents.flatMap((component) =>
      writtenFields(
        fs.readFileSync(path.join(componentsDir, component), "utf8")
      )
    );

    // The union is what the runtime classifies against (issue 78 F3): a key can be
    // protected without being supported -- `multi_user_mode` and `onboarding_complete`
    // are exactly that -- and computing `forbidden` from `supportedFields` alone left
    // those two outside the set this test guards, which is the case F3 existed to fix.
    const recognized = new Set([
      ...SystemSettings.protectedFields,
      ...SystemSettings.supportedFields,
    ]);
    const allowed = new Set(managerAllowedFields);
    const forbidden = new Set(
      [...recognized].filter((key) => !allowed.has(key))
    );

    expect([...allowed].every((key) => recognized.has(key))).toBe(true);
    expect([...allowed].every((key) => !forbidden.has(key))).toBe(true);
    expect(new Set([...allowed, ...forbidden])).toEqual(recognized);

    // The three lines above are true by construction -- `forbidden` is derived from
    // `recognized`, so they can never fail. What they cannot tell us is whether the
    // RUNTIME classifies the same way, which is the thing that was actually wrong
    // (issue 78 F3: the helper used the union while this test used supportedFields
    // alone, leaving multi_user_mode and onboarding_complete uncovered). So ask the
    // real helper, with an actor the engine denies, and require its answer to match.
    const engineModule = require("../../utils/authorization/engine");
    const realAuthorize =
      engineModule.DatabaseAuthorizationEngine.prototype.authorize;
    engineModule.DatabaseAuthorizationEngine.prototype.authorize = async () => ({
      allowed: false,
    });
    try {
      const refused = new Set();
      for (const key of recognized) {
        const outcome = await narrowManagerSystemPreferences(
          { type: "user", id: "1", orgId: 1 },
          { [key]: "probe" }
        );
        if (outcome.refusal) refused.add(key);
      }
      expect(refused).toEqual(forbidden);
    } finally {
      engineModule.DatabaseAuthorizationEngine.prototype.authorize = realAuthorize;
    }
    expect([...allowed].sort()).toEqual([...new Set(frontendFields)].sort());
  });

  it("classifies every frontend updateSystemPreferences caller", () => {
    const frontendDir = path.resolve(__dirname, "../../../frontend/src");
    const callers = [];
    function visit(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (/\.(js|jsx)$/.test(entry.name)) {
          const source = fs.readFileSync(absolute, "utf8");
          if (
            callsUpdateSystemPreferences(source) &&
            !absolute.endsWith("models/admin.js")
          )
            callers.push(path.relative(frontendDir, absolute));
        }
      }
    }
    visit(frontendDir);

    const managerCallerPaths = managerComponents.map(
      (component) => `pages/GeneralSettings/Settings/components/${component}`
    );
    expect(callers.sort()).toEqual(
      [...managerCallerPaths, ...Object.keys(nonManagerCallers)].sort()
    );
    for (const reason of Object.values(nonManagerCallers))
      expect(reason.trim().length).toBeGreaterThan(0);
  });
});
