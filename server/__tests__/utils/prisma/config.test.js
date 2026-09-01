describe("Prisma datasource override", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test.each([
    ["test", "file:/tmp/test.db", "file:/tmp/test.db"],
    ["production", "file:/tmp/test.db", undefined],
    ["development", "file:/tmp/test.db", undefined],
  ])(
    "NODE_ENV=%s applies expected datasource override",
    (nodeEnv, databaseUrl, expected) => {
      const PrismaClient = jest.fn(() => ({}));
      jest.doMock("@prisma/client", () => ({ PrismaClient }));
      process.env.NODE_ENV = nodeEnv;
      process.env.DATABASE_URL = databaseUrl;

      require("../../../utils/prisma");

      expect(PrismaClient).toHaveBeenCalledWith({
        log: ["error", "info", "warn"],
        ...(expected ? { datasourceUrl: expected } : {}),
      });
    }
  );
});
