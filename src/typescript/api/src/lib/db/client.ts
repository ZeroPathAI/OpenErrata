import "./prisma-enum-compat.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { normalizePgConnectionStringForNode } from "$lib/db/connection-string.js";
import { PrismaClient } from "$lib/generated/prisma/client";
import { getEnv } from "$lib/config/env.js";
import { Pool } from "pg";

export type { PrismaClient } from "$lib/generated/prisma/client";

declare global {
  // Reused across HMR reloads in development.
  var __openerrataPrisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const env = getEnv();
  const databaseUrl = normalizePgConnectionStringForNode(env.DATABASE_URL);

  const pool = new Pool({
    connectionString: databaseUrl,
    // Integration tests run as short-lived processes. Allowing exit on idle
    // avoids waiting for pg's default idle timeout (~10s) at process teardown.
    allowExitOnIdle: env.NODE_ENV === "test",
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

// Lazy singleton: deferred from module-load time so that `vite build` can
// compile the server bundle without a database connection or runtime secrets.
let prismaInstance: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  if (!prismaInstance) {
    prismaInstance = globalThis.__openerrataPrisma ?? createPrismaClient();
    if (getEnv().NODE_ENV !== "production") {
      globalThis.__openerrataPrisma = prismaInstance;
    }
  }
  return prismaInstance;
}
