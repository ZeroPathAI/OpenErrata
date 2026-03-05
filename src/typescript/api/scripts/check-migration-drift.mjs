import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { Client } from "pg";

function ensureDatabaseUrl() {
  const value = process.env["DATABASE_URL"];
  if (value === undefined || value.trim().length === 0) {
    throw new Error("DATABASE_URL is required to run the Prisma migration drift check.");
  }
  return value;
}

function databaseUrlForAdminConnection(databaseUrl) {
  const parsed = new globalThis.URL(databaseUrl);
  parsed.pathname = "/postgres";
  parsed.searchParams.delete("schema");
  return parsed.toString();
}

function databaseUrlWithDatabaseName(databaseUrl, databaseName) {
  const parsed = new globalThis.URL(databaseUrl);
  parsed.pathname = `/${databaseName}`;
  parsed.searchParams.delete("schema");
  return parsed.toString();
}

function buildShadowDatabaseName() {
  const randomSuffix = randomBytes(4).toString("hex");
  const databaseName = `prisma_drift_${Date.now().toString(36)}_${process.pid.toString(36)}_${randomSuffix}`;
  assertValidDatabaseName(databaseName);
  return databaseName;
}

function assertValidDatabaseName(databaseName) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(databaseName)) {
    throw new Error(`Generated invalid database name: ${databaseName}`);
  }
  if (databaseName.length > 63) {
    throw new Error(`Generated database name exceeds PostgreSQL limit: ${databaseName}`);
  }
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function createDatabase(databaseUrl, databaseName) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } finally {
    await client.end();
  }
}

async function dropDatabase(databaseUrl, databaseName) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()
      `,
      [databaseName],
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
  } finally {
    await client.end();
  }
}

function isExecFileError(error) {
  return typeof error === "object" && error !== null && "status" in error;
}

function runPrismaMigrationDiff(shadowDatabaseUrl) {
  try {
    execFileSync(
      "pnpm",
      [
        "exec",
        "prisma",
        "migrate",
        "diff",
        "--from-migrations",
        "prisma/migrations",
        "--to-schema",
        "prisma/schema.prisma",
        "--exit-code",
      ],
      {
        env: {
          ...process.env,
          PRISMA_SHADOW_DATABASE_URL: shadowDatabaseUrl,
        },
        stdio: "inherit",
      },
    );
  } catch (error) {
    if (isExecFileError(error) && error.status === 2) {
      throw new Error(
        "Prisma migration drift detected. Add/apply a migration so prisma/migrations and schema.prisma stay in sync.",
        { cause: error },
      );
    }
    throw error;
  }
}

function formatError(error) {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

async function main() {
  const baseDatabaseUrl = ensureDatabaseUrl();
  const adminDatabaseUrl = databaseUrlForAdminConnection(baseDatabaseUrl);
  const shadowDatabaseName = buildShadowDatabaseName();
  const shadowDatabaseUrl = databaseUrlWithDatabaseName(baseDatabaseUrl, shadowDatabaseName);

  await createDatabase(adminDatabaseUrl, shadowDatabaseName);
  try {
    runPrismaMigrationDiff(shadowDatabaseUrl);
  } finally {
    await dropDatabase(adminDatabaseUrl, shadowDatabaseName);
  }

  globalThis.console.log("Prisma migration drift check passed.");
}

void main().catch((error) => {
  globalThis.console.error(`Prisma migration drift check failed: ${formatError(error)}`);
  process.exit(1);
});
