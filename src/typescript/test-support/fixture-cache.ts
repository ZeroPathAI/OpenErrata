import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sanitizeFixtureKey(fixtureKey: string): string {
  return fixtureKey.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function readJsonFile(path: URL): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as unknown;
}

export async function writeJsonFile(path: URL, value: unknown): Promise<void> {
  await mkdir(new URL(".", path), { recursive: true });
  const normalized = JSON.stringify(value, null, 2) + "\n";
  await writeFile(path, normalized, "utf8");
}
