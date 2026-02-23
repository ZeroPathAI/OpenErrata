import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import "dotenv/config";
import { Client } from "pg";

function ensureDatabaseUrl(): string {
  const value = process.env['DATABASE_URL'];
  if (!value || value.trim().length === 0) {
    throw new Error("DATABASE_URL is required to run integration tests");
  }
  return value;
}

function buildTestDatabaseName(): string {
  const randomSuffix = randomBytes(4).toString("hex");
  return `it_${Date.now().toString(36)}_${process.pid.toString(36)}_${randomSuffix}`;
}

function buildTemplateDatabaseName(migrationsFingerprint: string): string {
  const databaseName = `it_template_${migrationsFingerprint}`;
  assertValidDatabaseName(databaseName);
  return databaseName;
}

function assertValidDatabaseName(databaseName: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(databaseName)) {
    throw new Error(`Generated invalid database name: ${databaseName}`);
  }
  if (databaseName.length > 63) {
    throw new Error(`Generated database name exceeds PostgreSQL limit: ${databaseName}`);
  }
}

function databaseUrlForAdminConnection(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  parsed.searchParams.delete("schema");
  return parsed.toString();
}

function databaseUrlWithDatabaseName(
  databaseUrl: string,
  databaseName: string,
): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${databaseName}`;
  parsed.searchParams.delete("schema");
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function createDatabase(
  databaseUrl: string,
  databaseName: string,
  options?: {
    templateDatabaseName?: string;
  },
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const templateClause = options?.templateDatabaseName
      ? ` TEMPLATE ${quoteIdentifier(options.templateDatabaseName)}`
      : "";
    await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}${templateClause}`);
  } finally {
    await client.end();
  }
}

async function dropDatabase(databaseUrl: string, databaseName: string): Promise<void> {
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

async function databaseExists(
  databaseUrl: string,
  databaseName: string,
): Promise<boolean> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ exists: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM pg_database
          WHERE datname = $1
        ) AS exists
      `,
      [databaseName],
    );
    const firstRow = result.rows[0];
    if (!firstRow) {
      throw new Error(`Unable to determine whether database exists: ${databaseName}`);
    }
    return firstRow.exists;
  } finally {
    await client.end();
  }
}

async function readMigrationsFingerprint(): Promise<string> {
  const migrationsDirectory = new URL("../../prisma/migrations/", import.meta.url);
  const migrationEntries = await readdir(migrationsDirectory, { withFileTypes: true });
  const migrationDirectoryNames = migrationEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (migrationDirectoryNames.length === 0) {
    throw new Error("No Prisma migrations were found for integration tests");
  }

  const hasher = createHash("sha256");
  for (const migrationDirectoryName of migrationDirectoryNames) {
    hasher.update(`${migrationDirectoryName}\n`);
    const migrationFile = new URL(
      `${migrationDirectoryName}/migration.sql`,
      migrationsDirectory,
    );
    const migrationSql = await readFile(migrationFile, "utf8");
    hasher.update(migrationSql);
    hasher.update("\n--next-migration--\n");
  }

  return hasher.digest("hex").slice(0, 16);
}

function hasPostgresErrorCode(error: unknown, expectedCode: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = error.code;
  return typeof code === "string" && code === expectedCode;
}

async function ensureTemplateDatabase(
  adminDatabaseUrl: string,
  baseDatabaseUrl: string,
  templateDatabaseName: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const templateAlreadyExists = await databaseExists(
    adminDatabaseUrl,
    templateDatabaseName,
  );
  if (templateAlreadyExists) {
    return;
  }

  let createdTemplateDatabase = false;
  try {
    await createDatabase(adminDatabaseUrl, templateDatabaseName);
    createdTemplateDatabase = true;
  } catch (error) {
    // Another process may create the template in parallel.
    if (!hasPostgresErrorCode(error, "42P04")) {
      throw error;
    }
  }

  const templateDatabaseUrl = databaseUrlWithDatabaseName(
    baseDatabaseUrl,
    templateDatabaseName,
  );
  const templateEnv: NodeJS.ProcessEnv = {
    ...env,
    DATABASE_URL: templateDatabaseUrl,
  };

  try {
    await runCommand("pnpm", ["run", "prisma:migrate:deploy"], templateEnv);
  } catch (error) {
    if (createdTemplateDatabase) {
      await dropDatabase(adminDatabaseUrl, templateDatabaseName);
    }
    throw error;
  }
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env,
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited from signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} exited with status ${code?.toString() ?? "unknown"}`));
        return;
      }
      resolve();
    });
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

async function main(): Promise<void> {
  const forwardedArgs = process.argv.slice(2);
  const baseDatabaseUrl = ensureDatabaseUrl();
  const migrationsFingerprint = await readMigrationsFingerprint();
  const templateDatabaseName = buildTemplateDatabaseName(migrationsFingerprint);
  const testDatabaseName = buildTestDatabaseName();
  assertValidDatabaseName(testDatabaseName);

  const adminDatabaseUrl = databaseUrlForAdminConnection(baseDatabaseUrl);
  const isolatedDatabaseUrl = databaseUrlWithDatabaseName(
    baseDatabaseUrl,
    testDatabaseName,
  );
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    HMAC_SECRET: "test-hmac-secret",
    BLOB_STORAGE_PROVIDER: "aws",
    BLOB_STORAGE_REGION: "us-east-1",
    BLOB_STORAGE_ENDPOINT: "",
    BLOB_STORAGE_BUCKET: "test-openerrata-images",
    BLOB_STORAGE_ACCESS_KEY_ID: "test-blob-access-key",
    BLOB_STORAGE_SECRET_ACCESS_KEY: "test-blob-secret",
    BLOB_STORAGE_PUBLIC_URL_PREFIX: "https://example.test/images",
    DATABASE_ENCRYPTION_KEY: "integration-test-database-encryption-key",
    DATABASE_URL: isolatedDatabaseUrl,
  };

  let primaryError: Error | null = null;
  let cleanupError: Error | null = null;
  await ensureTemplateDatabase(
    adminDatabaseUrl,
    baseDatabaseUrl,
    templateDatabaseName,
    childEnv,
  );
  await createDatabase(adminDatabaseUrl, testDatabaseName, {
    templateDatabaseName,
  });
  try {
    const testArgs = ["run", "test:integration:raw"];
    if (forwardedArgs.length > 0) {
      testArgs.push("--", ...forwardedArgs);
    }
    await runCommand("pnpm", testArgs, childEnv);
  } catch (error) {
    primaryError = toError(error);
  } finally {
    try {
      await dropDatabase(adminDatabaseUrl, testDatabaseName);
    } catch (caughtCleanupError) {
      cleanupError = toError(caughtCleanupError);
      if (primaryError) {
        console.error(
          `Integration test cleanup failed while handling prior error: ${formatError(cleanupError)}`,
        );
      }
    }
  }

  if (primaryError) {
    throw primaryError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

void main().catch((error: unknown) => {
  const message = formatError(error);
  console.error(`Integration test runner failed: ${message}`);
  process.exit(1);
});
