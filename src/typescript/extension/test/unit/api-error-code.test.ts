import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractApiErrorCode,
  extractMinimumSupportedExtensionVersion,
} from "../../src/background/api-error-code.js";

test("extractApiErrorCode reads openerrataCode from tRPC data", () => {
  assert.equal(
    extractApiErrorCode({
      data: { openerrataCode: "INVALID_EXTENSION_MESSAGE" },
    }),
    "INVALID_EXTENSION_MESSAGE",
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
        data: { openerrataCode: "UNSUPPORTED_PROTOCOL_VERSION" },
      },
    }),
    "UNSUPPORTED_PROTOCOL_VERSION",
  );
});

test("extractApiErrorCode reads UPGRADE_REQUIRED code from tRPC data", () => {
  assert.equal(
    extractApiErrorCode({
      data: { openerrataCode: "UPGRADE_REQUIRED" },
    }),
    "UPGRADE_REQUIRED",
  );
});

test("extractApiErrorCode reads MALFORMED_EXTENSION_VERSION code from tRPC data", () => {
  assert.equal(
    extractApiErrorCode({
      data: { openerrataCode: "MALFORMED_EXTENSION_VERSION" },
    }),
    "MALFORMED_EXTENSION_VERSION",
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
      data: { openerrataCode: "MALFORMED_EXTENSION_VERSION" },
    },
  };
  assert.equal(extractApiErrorCode(nested), "MALFORMED_EXTENSION_VERSION");
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

test("extractMinimumSupportedExtensionVersion reads version from tRPC data payload", () => {
  assert.equal(
    extractMinimumSupportedExtensionVersion({
      data: { minimumSupportedExtensionVersion: "1.2.3" },
    }),
    "1.2.3",
  );
});

test("extractMinimumSupportedExtensionVersion reads version from nested shape data", () => {
  assert.equal(
    extractMinimumSupportedExtensionVersion({
      shape: {
        data: { minimumSupportedExtensionVersion: "2.0.0.1" },
      },
    }),
    "2.0.0.1",
  );
});

test("extractMinimumSupportedExtensionVersion follows cause chains", () => {
  assert.equal(
    extractMinimumSupportedExtensionVersion({
      cause: {
        data: { minimumSupportedExtensionVersion: "3.4.5" },
      },
    }),
    "3.4.5",
  );
});

test("extractMinimumSupportedExtensionVersion rejects invalid version metadata", () => {
  assert.equal(
    extractMinimumSupportedExtensionVersion({
      data: { minimumSupportedExtensionVersion: "v1.2.3" },
    }),
    undefined,
  );
  assert.equal(
    extractMinimumSupportedExtensionVersion({
      data: { minimumSupportedExtensionVersion: 123 },
    }),
    undefined,
  );
});
