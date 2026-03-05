import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isCloudflareR2Endpoint,
  isIpv4Address,
  normalizeDnsCompatibleComponent,
  parseCsvList,
  resolveCloudflareRecordSpec,
  resolveHelmFullname,
  resolveIngressLoadBalancerTarget,
  truncateK8sName,
  truncateName,
} from "../../lib/config-helpers.js";

test("normalizeDnsCompatibleComponent normalizes stack names for DNS labels", () => {
  assert.equal(normalizeDnsCompatibleComponent("Main_Stack!"), "main-stack");
  assert.equal(normalizeDnsCompatibleComponent("---alpha---beta---"), "alpha-beta");
});

test("truncateName and truncateK8sName trim trailing hyphens after slicing", () => {
  assert.equal(truncateName("abc-def-", 7), "abc-def");
  assert.equal(truncateK8sName("a".repeat(62) + "-"), "a".repeat(62));
});

test("parseCsvList parses comma-separated values and drops empty entries", () => {
  assert.deepEqual(parseCsvList("a, b ,, c"), ["a", "b", "c"]);
  assert.equal(parseCsvList(undefined), undefined);
  assert.equal(parseCsvList(" , , "), undefined);
});

test("isIpv4Address validates IPv4 dotted decimal strings", () => {
  assert.equal(isIpv4Address("203.0.113.7"), true);
  assert.equal(isIpv4Address("256.0.0.1"), false);
  assert.equal(isIpv4Address("example.com"), false);
});

test("isCloudflareR2Endpoint accepts URL and hostname forms", () => {
  assert.equal(isCloudflareR2Endpoint("https://account-id.r2.cloudflarestorage.com"), true);
  assert.equal(isCloudflareR2Endpoint("account-id.r2.cloudflarestorage.com"), true);
  assert.equal(isCloudflareR2Endpoint("https://s3.us-west-2.amazonaws.com"), false);
});

test("resolveHelmFullname respects fullname override and release/chart conventions", () => {
  assert.equal(
    resolveHelmFullname({
      releaseName: "openerrata-main",
      chartName: "openerrata",
      nameOverride: undefined,
      fullnameOverride: "my-full-name",
    }),
    "my-full-name",
  );

  assert.equal(
    resolveHelmFullname({
      releaseName: "openerrata-main",
      chartName: "openerrata",
      nameOverride: undefined,
      fullnameOverride: undefined,
    }),
    "openerrata-main",
  );

  assert.equal(
    resolveHelmFullname({
      releaseName: "main",
      chartName: "openerrata",
      nameOverride: undefined,
      fullnameOverride: undefined,
    }),
    "main-openerrata",
  );
});

test("resolveIngressLoadBalancerTarget prefers hostname then ip", () => {
  assert.equal(
    resolveIngressLoadBalancerTarget({
      loadBalancer: {
        ingress: [{ hostname: "lb.example.com" }, { ip: "203.0.113.8" }],
      },
    }),
    "lb.example.com",
  );

  assert.equal(
    resolveIngressLoadBalancerTarget({
      loadBalancer: {
        ingress: [{ ip: "203.0.113.8" }],
      },
    }),
    "203.0.113.8",
  );
});

test("resolveCloudflareRecordSpec picks A for IPv4 and CNAME for hostnames", () => {
  assert.deepEqual(resolveCloudflareRecordSpec("203.0.113.7", undefined), {
    type: "A",
    content: "203.0.113.7",
  });

  assert.deepEqual(resolveCloudflareRecordSpec("lb.example.com", undefined), {
    type: "CNAME",
    content: "lb.example.com",
  });

  assert.deepEqual(
    resolveCloudflareRecordSpec(undefined, {
      loadBalancer: {
        ingress: [{ hostname: "lb.example.com" }],
      },
    }),
    {
      type: "CNAME",
      content: "lb.example.com",
    },
  );
});
