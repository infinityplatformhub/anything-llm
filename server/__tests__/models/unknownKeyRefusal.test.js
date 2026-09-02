const { SystemSettings } = require("../../models/systemSettings");

beforeEach(() => jest.restoreAllMocks());

describe("unknown settings key refusal", () => {
  test("mixed keys fail without writing and preserve caller input", async () => {
    const updates = {
      not_a_real_key: "x",
      support_email: "mixed@example.com",
    };
    const original = { ...updates };
    const write = jest.spyOn(SystemSettings, "_updateSettings");

    await expect(SystemSettings.updateSettings(updates)).resolves.toEqual({
      success: false,
      error: "Unknown setting keys: not_a_real_key",
      code: "unknown_keys",
      unknownKeys: ["not_a_real_key"],
    });
    expect(write).not.toHaveBeenCalled();
    expect(updates).toEqual(original);
  });

  test("all-valid keys still reach the settings writer", async () => {
    const updates = { support_email: "valid@example.com" };
    const write = jest
      .spyOn(SystemSettings, "_updateSettings")
      .mockResolvedValue({ success: true, error: null });

    await expect(SystemSettings.updateSettings(updates)).resolves.toEqual({
      success: true,
      error: null,
    });
    expect(write).toHaveBeenCalledWith({ support_email: "valid@example.com" });
  });
});
