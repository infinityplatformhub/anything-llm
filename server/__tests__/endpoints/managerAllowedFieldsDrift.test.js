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
});
