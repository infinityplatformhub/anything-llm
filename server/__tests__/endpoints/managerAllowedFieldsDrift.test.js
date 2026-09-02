const fs = require("fs");
const path = require("path");
const { SystemSettings } = require("../../models/systemSettings");
const {
  managerAllowedFields,
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
  it("matches fields written by manager-reachable settings components", () => {
    const componentsDir = path.resolve(
      __dirname,
      "../../../frontend/src/pages/GeneralSettings/Settings/components"
    );
    const frontendFields = managerComponents.flatMap((component) =>
      writtenFields(
        fs.readFileSync(path.join(componentsDir, component), "utf8")
      )
    );

    const supported = new Set(SystemSettings.supportedFields);
    const allowed = new Set(managerAllowedFields);
    const forbidden = new Set(
      SystemSettings.supportedFields.filter((key) => !allowed.has(key))
    );

    expect([...allowed].every((key) => supported.has(key))).toBe(true);
    expect([...allowed].every((key) => !forbidden.has(key))).toBe(true);
    expect(new Set([...allowed, ...forbidden])).toEqual(supported);
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
            source.includes("updateSystemPreferences(") &&
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
