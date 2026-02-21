import "./prisma-enum-compat.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "$lib/generated/prisma/client";
import { getEnv } from "$lib/config/env.js";
import { Pool } from "pg";

declare global {
  // Reused across HMR reloads in development.
  var __openerrataPrisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const env = getEnv();
  const databaseUrl = env.DATABASE_URL;

  const pool = new Pool({
    connectionString: databaseUrl,
    // Integration tests run as short-lived processes. Allowing exit on idle
    // avoids waiting for pg's default idle timeout (~10s) at process teardown.
    allowExitOnIdle: env.NODE_ENV === "test",
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export const prisma = globalThis.__openerrataPrisma ?? createPrismaClient();

if (getEnv().NODE_ENV !== "production") {
  globalThis.__openerrataPrisma = prisma;
}
