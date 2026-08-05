import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrationsDir = new URL("./migrations", import.meta.url).pathname;
  const migrations = await readD1Migrations(migrationsDir);
  return {
    test: {
      setupFiles: ["./test/apply-migrations.js"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.test.jsonc" },
          miniflare: {
            d1Databases: ["DB"],
            r2Buckets: ["R2"],
            bindings: {
              TEST_MIGRATIONS: migrations,
              ADMIN_TOKEN: "test-admin-token",
              TICKET_SECRET: "test-ticket-secret",
            },
          },
        },
      },
    },
  };
});
