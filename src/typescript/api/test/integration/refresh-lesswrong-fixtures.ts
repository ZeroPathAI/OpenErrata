import {
  captureLesswrongFixture,
  resolveLesswrongFixtureDefinition,
} from "./lesswrong-fixtures.js";

type RefreshMode = {
  fixtureKey: string;
  externalId: string;
  postUrl: string;
};

function readInputFixtureKeys(): RefreshMode[] {
  const raw = (process.env["LESSWRONG_FIXTURE_KEYS"] ?? "").trim();
  const fromEnv =
    raw.length === 0
      ? []
      : raw
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
  const fromArgs = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);
  const keys = fromArgs.length > 0 ? fromArgs : fromEnv;

  return keys.map((fixtureKey) => ({
    ...resolveLesswrongFixtureDefinition(fixtureKey),
  }));
}

async function main(): Promise<void> {
  const modes = readInputFixtureKeys();
  if (modes.length === 0) {
    throw new Error(
      "No fixture keys provided. Use CLI args or set LESSWRONG_FIXTURE_KEYS (comma-separated).",
    );
  }

  let hadError = false;
  for (const mode of modes) {
    try {
      await captureLesswrongFixture(mode);
      console.log(`[fixtures] refreshed ${mode.fixtureKey}`);
    } catch (error) {
      hadError = true;
      console.error(`[fixtures] failed ${mode.fixtureKey}:`, error);
    }
  }

  if (hadError) {
    throw new Error("One or more fixture refresh operations failed.");
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fixture refresh failed: ${message}`);
  process.exit(1);
});
