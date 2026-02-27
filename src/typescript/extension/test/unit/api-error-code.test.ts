import assert from "node:assert/strict";
import { test } from "node:test";
import { extractApiErrorCode } from "../../src/background/api-error-code.js";

test("extractApiErrorCode reads openerrataCode from tRPC data", () => {
  assert.equal(
    extractApiErrorCode({
      data: { openerrataCode: "CONTENT_MISMATCH" },
    }),
    "CONTENT_MISMATCH",
  );
});

test("extractApiErrorCode reads direct PAYLOAD_TOO_LARGE errorCode", () => {
  assert.equal(
    extractApiErrorCode({
      errorCode: "PAYLOAD_TOO_LARGE",
    }),
    "PAYLOAD_TOO_LARGE",
  );
});

test("extractApiErrorCode reads openerrataCode from nested shape data", () => {
  assert.equal(
    extractApiErrorCode({
      shape: {
        data: { openerrataCode: "CONTENT_MISMATCH" },
      },
    }),
    "CONTENT_MISMATCH",
  );
});

test("extractApiErrorCode maps data.httpStatus=413 to PAYLOAD_TOO_LARGE", () => {
  assert.equal(
    extractApiErrorCode({
      data: { httpStatus: 413 },
    }),
    "PAYLOAD_TOO_LARGE",
  );
});

test("extractApiErrorCode maps meta.response.status=413 to PAYLOAD_TOO_LARGE", () => {
  assert.equal(
    extractApiErrorCode({
      meta: { response: { status: 413 } },
    }),
    "PAYLOAD_TOO_LARGE",
  );
});

test("extractApiErrorCode walks cause chain", () => {
  const nested = {
    cause: {
      data: { openerrataCode: "CONTENT_MISMATCH" },
    },
  };
  assert.equal(extractApiErrorCode(nested), "CONTENT_MISMATCH");
});

test("extractApiErrorCode returns undefined for circular cause chains", () => {
  const circular: { cause?: unknown } = {};
  circular.cause = circular;

  assert.equal(extractApiErrorCode(circular), undefined);
});

test("extractApiErrorCode returns undefined for unknown codes", () => {
  assert.equal(
    extractApiErrorCode({
      data: { openerrataCode: "UNRECOGNIZED" },
    }),
    undefined,
  );
});
