const { SystemSettings } = require("../../models/systemSettings");

beforeEach(() => jest.restoreAllMocks());

describe("refused settings keys", () => {
  test("mixed input reports unknown keys before filtering", async () => {
    const write = jest.spyOn(SystemSettings, "_updateSettings");

    await expect(
      SystemSettings.updateSettings({
        not_a_real_key: "x",
        support_email: "mixed@example.com",
      })
    ).resolves.toMatchObject({
      success: false,
      code: "unknown_keys",
      unknownKeys: ["not_a_real_key"],
      unknownKeyCount: 1,
    });
    expect(write).not.toHaveBeenCalled();
  });

  test("refusal preserves deep input and key order", async () => {
    const updates = JSON.parse(
      '{"not_a_real_key":{"nested":[1,2]},"support_email":"mixed@example.com"}'
    );
    const serialized = JSON.stringify(updates);
    const keyOrder = Object.keys(updates);

    await SystemSettings.updateSettings(updates);

    expect(JSON.stringify(updates)).toBe(serialized);
    expect(Object.keys(updates)).toEqual(keyOrder);
  });

  test.each(["multi_user_mode", "hub_api_key", "onboarding_complete"])(
    "%s is classified as protected",
    async (key) => {
      await expect(
        SystemSettings.updateSettings({ [key]: "value" })
      ).resolves.toMatchObject({
        success: false,
        code: "protected_keys",
        protectedKeys: [key],
      });
    }
  );

  test("caps reflected unknown keys and reports true count", async () => {
    const updates = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`unknown_${index}`, index])
    );

    const result = await SystemSettings.updateSettings(updates);

    expect(result.unknownKeys).toHaveLength(50);
    expect(result.unknownKeyCount).toBe(60);
  });

  test("truncates by code points only beyond 64 characters", async () => {
    const key63 = "a".repeat(63);
    const key64 = "b".repeat(64);
    const key65 = "c".repeat(65);
    const emoji64 = "😀".repeat(64);
    const longKeys = ["d".repeat(65), "e".repeat(65), "f".repeat(65)];

    const result = await SystemSettings.updateSettings(
      Object.fromEntries(
        [key63, key64, key65, emoji64, ...longKeys].map((key) => [key, 1])
      )
    );

    expect(result.unknownKeys).toEqual([
      key63,
      key64,
      `${"c".repeat(64)}…`,
      emoji64,
      ...longKeys.map((key) => `${key.slice(0, 64)}…`),
    ]);
  });

  test.each(["__proto__", "constructor", "prototype"])(
    "%s stays an ordinary unknown key without prototype pollution",
    async (key) => {
      const updates = JSON.parse(`{"${key}":{"x":"polluted"}}`);

      const result = await SystemSettings.updateSettings(updates);

      expect(result).toMatchObject({
        code: "unknown_keys",
        unknownKeys: [key],
      });
      expect({}.x).toBeUndefined();
    }
  );

  test("all-valid keys reach the settings writer through a null-prototype copy", async () => {
    const updates = { support_email: "valid@example.com" };
    const write = jest
      .spyOn(SystemSettings, "_updateSettings")
      .mockResolvedValue({ success: true, error: null });

    await expect(SystemSettings.updateSettings(updates)).resolves.toEqual({
      success: true,
      error: null,
    });
    const copied = write.mock.calls[0][0];
    expect(copied).toEqual(updates);
    expect(Object.getPrototypeOf(copied)).toBeNull();
  });
});
