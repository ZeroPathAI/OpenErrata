import "dotenv/config";
import { defineConfig, env } from "prisma/config";

const shadowDatabaseUrl = process.env["PRISMA_SHADOW_DATABASE_URL"]?.trim();
const hasShadowDatabaseUrl = shadowDatabaseUrl !== undefined && shadowDatabaseUrl.length > 0;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
    ...(hasShadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
});
