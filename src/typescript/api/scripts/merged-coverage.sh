#!/usr/bin/env bash
# Collects V8 coverage from both unit and integration test suites,
# then checks merged coverage against the thresholds in .c8rc.api.json.
#
# This avoids maintaining a hand-curated file list in the c8 config —
# any new source file is automatically included via globs.
set -euo pipefail

C8_CONFIG="../.c8rc.api.json"
COVERAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$COVERAGE_DIR"' EXIT

C8_COMMON_ARGS="--config $C8_CONFIG --temp-directory $COVERAGE_DIR --reporter none --check-coverage false"

echo "--- Unit tests (coverage → $COVERAGE_DIR) ---"
pnpm exec c8 $C8_COMMON_ARGS \
  tsx --test "test/unit/**/*.test.ts"

# The integration test harness spawns the test runner as a child process.
# --exec-prefix wraps that child with c8 so coverage is collected into
# the same temp directory. The harness handles DB setup/teardown around it.
echo "--- Integration tests (coverage → $COVERAGE_DIR) ---"
pnpm exec tsx test/integration/run-integration-tests.ts \
  --exec-prefix c8 \
  --config "$C8_CONFIG" \
  --temp-directory "$COVERAGE_DIR" \
  --reporter none \
  --check-coverage false \
  --clean false

echo "--- Merged coverage report ---"
pnpm exec c8 report \
  --config "$C8_CONFIG" \
  --temp-directory "$COVERAGE_DIR" \
  --reporter text-summary
