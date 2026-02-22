import { config as loadDotenv } from "dotenv";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "$lib/generated/prisma/client";
import { Pool } from "pg";
import { hashInstanceApiKey } from "$lib/services/instance-api-key.js";

loadDotenv();

type Command = "list" | "activate" | "revoke";
type StatusFilter = "all" | "active" | "revoked";

type ParsedArguments = {
  command: Command;
  options: Map<string, string>;
};

type InstanceApiKeyRow = {
  id: string;
  name: string;
  keyHash: string;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type SerializedInstanceApiKey = {
  id: string;
  name: string;
  keyHash: string;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const instanceApiKeySelect = {
  id: true,
  name: true,
  keyHash: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

function usage(): string {
  return [
    "Usage:",
    "  pnpm --filter @openerrata/api run instance-api-key <command> [options]",
    "",
    "Commands:",
    "  list [--status all|active|revoked]",
    "  activate --name <name> --key <raw-api-key>",
    "  revoke --key <raw-api-key>",
    "",
    "Examples:",
    "  pnpm --filter @openerrata/api run instance-api-key list --status active",
    '  pnpm --filter @openerrata/api run instance-api-key activate --name "prod-extension" --key "example-key"',
    '  pnpm --filter @openerrata/api run instance-api-key revoke --key "example-key"',
  ].join("\n");
}

function parseOptionPairs(tokens: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      throw new Error(
        `Unexpected argument "${token}".\n\n${usage()}`,
      );
    }

    const optionName = token.slice(2);
    if (optionName.length === 0) {
      throw new Error(`Invalid option "${token}".\n\n${usage()}`);
    }
    if (options.has(optionName)) {
      throw new Error(`Duplicate option "--${optionName}".`);
    }

    if (i + 1 >= tokens.length) {
      throw new Error(`Option "--${optionName}" requires a value.`);
    }

    const nextToken = tokens[i + 1];
    if (nextToken.startsWith("--")) {
      throw new Error(`Option "--${optionName}" requires a value.`);
    }

    options.set(optionName, nextToken);
    i++;
  }

  return options;
}

function parseArguments(tokens: readonly string[]): ParsedArguments {
  if (tokens.length === 0) {
    throw new Error(usage());
  }
  const commandToken = tokens[0];

  if (
    commandToken !== "list" &&
    commandToken !== "activate" &&
    commandToken !== "revoke"
  ) {
    throw new Error(`Unknown command "${commandToken}".\n\n${usage()}`);
  }

  return {
    command: commandToken,
    options: parseOptionPairs(tokens.slice(1)),
  };
}

function stripLeadingArgSeparator(tokens: readonly string[]): readonly string[] {
  if (tokens[0] === "--") {
    return tokens.slice(1);
  }
  return tokens;
}

function assertAllowedOptions(
  options: Map<string, string>,
  allowedOptions: readonly string[],
): void {
  const allowedSet = new Set(allowedOptions);
  for (const optionName of options.keys()) {
    if (!allowedSet.has(optionName)) {
      throw new Error(
        `Unsupported option "--${optionName}" for this command.`,
      );
    }
  }
}

function requireOption(options: Map<string, string>, optionName: string): string {
  const rawValue = options.get(optionName);
  if (rawValue === undefined) {
    throw new Error(`Missing required option "--${optionName}".`);
  }

  const value = rawValue.trim();
  if (value.length === 0) {
    throw new Error(`Option "--${optionName}" must be non-empty.`);
  }

  return value;
}

function readStatusFilter(options: Map<string, string>): StatusFilter {
  const rawStatus = options.get("status");
  if (rawStatus === undefined) {
    return "all";
  }

  const normalized = rawStatus.trim().toLowerCase();
  if (normalized === "all" || normalized === "active" || normalized === "revoked") {
    return normalized;
  }

  throw new Error(
    `Invalid status "${rawStatus}". Expected one of: all, active, revoked.`,
  );
}

function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("DATABASE_URL is required.");
  }
  return value.trim();
}

function createScriptPrismaClient(): PrismaClient {
  const pool = new Pool({
    connectionString: requireDatabaseUrl(),
    allowExitOnIdle: true,
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

function serializeInstanceApiKey(
  key: InstanceApiKeyRow,
): SerializedInstanceApiKey {
  return {
    id: key.id,
    name: key.name,
    keyHash: key.keyHash,
    revokedAt: key.revokedAt ? key.revokedAt.toISOString() : null,
    createdAt: key.createdAt.toISOString(),
    updatedAt: key.updatedAt.toISOString(),
  };
}

async function listInstanceApiKeys(
  prisma: PrismaClient,
  options: Map<string, string>,
): Promise<void> {
  assertAllowedOptions(options, ["status"]);
  const status = readStatusFilter(options);
  const orderBy: Prisma.InstanceApiKeyOrderByWithRelationInput[] = [
    { revokedAt: "asc" },
    { name: "asc" },
    { createdAt: "asc" },
  ];

  let keys: InstanceApiKeyRow[];
  if (status === "active") {
    keys = await prisma.instanceApiKey.findMany({
      where: { revokedAt: null },
      orderBy,
      select: instanceApiKeySelect,
    });
  } else if (status === "revoked") {
    keys = await prisma.instanceApiKey.findMany({
      where: { revokedAt: { not: null } },
      orderBy,
      select: instanceApiKeySelect,
    });
  } else {
    keys = await prisma.instanceApiKey.findMany({
      orderBy,
      select: instanceApiKeySelect,
    });
  }

  console.log(
    JSON.stringify(
      {
        status,
        count: keys.length,
        keys: keys.map(serializeInstanceApiKey),
      },
      null,
      2,
    ),
  );
}

async function activateInstanceApiKey(
  prisma: PrismaClient,
  options: Map<string, string>,
): Promise<void> {
  assertAllowedOptions(options, ["name", "key"]);
  const name = requireOption(options, "name");
  const rawKey = requireOption(options, "key");
  const keyHash = hashInstanceApiKey(rawKey);

  const existing = await prisma.instanceApiKey.findUnique({
    where: { keyHash },
    select: { revokedAt: true },
  });

  const action =
    existing === null
      ? "created"
      : existing.revokedAt === null
        ? "updated"
        : "reactivated";

  const key =
    existing === null
      ? await prisma.instanceApiKey.create({
          data: { name, keyHash },
          select: instanceApiKeySelect,
        })
      : await prisma.instanceApiKey.update({
          where: { keyHash },
          data: { name, revokedAt: null },
          select: instanceApiKeySelect,
        });

  console.log(
    JSON.stringify(
      {
        action,
        key: serializeInstanceApiKey(key),
      },
      null,
      2,
    ),
  );
}

async function revokeInstanceApiKey(
  prisma: PrismaClient,
  options: Map<string, string>,
): Promise<void> {
  assertAllowedOptions(options, ["key"]);
  const rawKey = requireOption(options, "key");
  const keyHash = hashInstanceApiKey(rawKey);

  const existing = await prisma.instanceApiKey.findUnique({
    where: { keyHash },
    select: instanceApiKeySelect,
  });

  if (existing === null) {
    throw new Error("No instance API key exists for the provided key.");
  }

  if (existing.revokedAt !== null) {
    console.log(
      JSON.stringify(
        {
          action: "already_revoked",
          key: serializeInstanceApiKey(existing),
        },
        null,
        2,
      ),
    );
    return;
  }

  const key = await prisma.instanceApiKey.update({
    where: { keyHash },
    data: { revokedAt: new Date() },
    select: instanceApiKeySelect,
  });

  console.log(
    JSON.stringify(
      {
        action: "revoked",
        key: serializeInstanceApiKey(key),
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const tokens = stripLeadingArgSeparator(process.argv.slice(2));
  if (tokens.length === 0) {
    console.log(usage());
    return;
  }

  const commandToken = tokens[0];
  if (
    commandToken === "help" ||
    commandToken === "--help" ||
    commandToken === "-h"
  ) {
    console.log(usage());
    return;
  }

  const { command, options } = parseArguments(tokens);
  const prisma = createScriptPrismaClient();

  try {
    if (command === "list") {
      await listInstanceApiKeys(prisma, options);
      return;
    }
    if (command === "activate") {
      await activateInstanceApiKey(prisma, options);
      return;
    }
    await revokeInstanceApiKey(prisma, options);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error("Unknown error", error);
  }
  process.exit(1);
});
