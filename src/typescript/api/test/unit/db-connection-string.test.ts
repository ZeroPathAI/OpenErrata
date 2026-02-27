import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePgConnectionStringForNode } from "../../src/lib/db/connection-string.js";

test("adds uselibpqcompat for sslmode=require", () => {
  const input = "postgresql://user:pass@db.example.com:5432/openerrata?sslmode=require";
  const output = normalizePgConnectionStringForNode(input);
  const url = new URL(output);

  assert.equal(url.searchParams.get("sslmode"), "require");
  assert.equal(url.searchParams.get("uselibpqcompat"), "true");
});

test("adds uselibpqcompat for sslmode=prefer and sslmode=allow", () => {
  const prefer = normalizePgConnectionStringForNode(
    "postgresql://user:pass@db.example.com/openerrata?sslmode=prefer",
  );
  const allow = normalizePgConnectionStringForNode(
    "postgresql://user:pass@db.example.com/openerrata?sslmode=allow",
  );

  assert.equal(new URL(prefer).searchParams.get("uselibpqcompat"), "true");
  assert.equal(new URL(allow).searchParams.get("uselibpqcompat"), "true");
});

test("leaves connection strings unchanged when sslmode is absent", () => {
  const input = "postgresql://user:pass@db.example.com:5432/openerrata";
  assert.equal(normalizePgConnectionStringForNode(input), input);
});

test("leaves connection strings unchanged when uselibpqcompat is already present", () => {
  const input =
    "postgresql://user:pass@db.example.com/openerrata?sslmode=require&uselibpqcompat=false";
  assert.equal(normalizePgConnectionStringForNode(input), input);
});

test("leaves strict sslmodes unchanged", () => {
  const verifyFull = "postgresql://user:pass@db.example.com/openerrata?sslmode=verify-full";
  const verifyCa = "postgresql://user:pass@db.example.com/openerrata?sslmode=verify-ca";
  const disable = "postgresql://user:pass@db.example.com/openerrata?sslmode=disable";

  assert.equal(normalizePgConnectionStringForNode(verifyFull), verifyFull);
  assert.equal(normalizePgConnectionStringForNode(verifyCa), verifyCa);
  assert.equal(normalizePgConnectionStringForNode(disable), disable);
});
