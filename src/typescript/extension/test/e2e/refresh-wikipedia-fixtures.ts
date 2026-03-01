import {
  captureE2eWikipediaFixture,
  resolveE2eWikipediaFixtureDefinition,
} from "./wikipedia-fixtures.js";

interface RefreshMode {
  fixtureKey: string;
  sourceUrl: string;
}

function readInputFixtureKeys(): RefreshMode[] {
  // eslint-disable-next-line @typescript-eslint/dot-notation
  const raw = (process.env["WIKIPEDIA_FIXTURE_KEYS"] ?? "").trim();
  const fromEnv =
    raw.length === 0
      ? []
      : raw
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
  const fromArgs = process.argv
    .slice(2)
    .map((value) => value.trim())
    .filter(Boolean);
  const keys = fromArgs.length > 0 ? fromArgs : fromEnv;

  return keys.map((fixtureKey) => ({
    ...resolveE2eWikipediaFixtureDefinition(fixtureKey),
  }));
}

async function main(): Promise<void> {
  const modes = readInputFixtureKeys();
  if (modes.length === 0) {
    throw new Error(
      "No fixture keys provided. Use CLI args or set WIKIPEDIA_FIXTURE_KEYS (comma-separated).",
    );
  }

  let hadError = false;
  for (const mode of modes) {
    try {
      await captureE2eWikipediaFixture(mode);
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
  console.error(`Wikipedia fixture refresh failed: ${message}`);
  process.exit(1);
});
