import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import process from "node:process";
import "dotenv/config";
import { Client } from "pg";

function ensureDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value || value.trim().length === 0) {
    throw new Error("DATABASE_URL is required to run integration tests");
  }
  return value;
}

function buildTestDatabaseName(): string {
  const randomSuffix = randomBytes(4).toString("hex");
  return `it_${Date.now().toString(36)}_${process.pid.toString(36)}_${randomSuffix}`;
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

async function createDatabase(databaseUrl: string, databaseName: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
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

async function main(): Promise<void> {
  const forwardedArgs = process.argv.slice(2);
  const baseDatabaseUrl = ensureDatabaseUrl();
  const testDatabaseName = buildTestDatabaseName();
  assertValidDatabaseName(testDatabaseName);

  const adminDatabaseUrl = databaseUrlForAdminConnection(baseDatabaseUrl);
  const isolatedDatabaseUrl = databaseUrlWithDatabaseName(
    baseDatabaseUrl,
    testDatabaseName,
  );
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: isolatedDatabaseUrl,
  };

  let primaryError: unknown | null = null;
  await createDatabase(adminDatabaseUrl, testDatabaseName);
  try {
    await runCommand("pnpm", ["run", "prisma:migrate:deploy"], childEnv);

    const testArgs = ["run", "test:integration:raw"];
    if (forwardedArgs.length > 0) {
      testArgs.push("--", ...forwardedArgs);
    }
    await runCommand("pnpm", testArgs, childEnv);
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await dropDatabase(adminDatabaseUrl, testDatabaseName);
    } catch (cleanupError) {
      if (primaryError) {
        console.error(
          `Integration test cleanup failed while handling prior error: ${formatError(cleanupError)}`,
        );
      } else {
        throw cleanupError;
      }
    }
  }

  if (primaryError) {
    throw primaryError;
  }
}

void main().catch((error) => {
  const message = formatError(error);
  console.error(`Integration test runner failed: ${message}`);
  process.exit(1);
});
