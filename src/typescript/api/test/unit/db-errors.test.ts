import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "../../src/lib/generated/prisma/client.js";
import { isRecordNotFoundError, isUniqueConstraintError } from "../../src/lib/db/errors.js";

function createKnownRequestError(code: "P2002" | "P2025") {
  return new Prisma.PrismaClientKnownRequestError("mock error", {
    code,
    clientVersion: "unit-test",
  });
}

test("isUniqueConstraintError detects P2002 prisma request errors", () => {
  assert.equal(isUniqueConstraintError(createKnownRequestError("P2002")), true);
  assert.equal(isUniqueConstraintError(createKnownRequestError("P2025")), false);
  assert.equal(isUniqueConstraintError(new Error("not prisma")), false);
});

test("isRecordNotFoundError detects P2025 prisma request errors", () => {
  assert.equal(isRecordNotFoundError(createKnownRequestError("P2025")), true);
  assert.equal(isRecordNotFoundError(createKnownRequestError("P2002")), false);
  assert.equal(isRecordNotFoundError(new Error("not prisma")), false);
});
