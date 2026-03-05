interface HelmNameInput {
  releaseName: string;
  chartName: string;
  nameOverride: string | undefined;
  fullnameOverride: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeDnsCompatibleComponent(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

export function truncateName(value: string, maxLength: number): string {
  return value.slice(0, maxLength).replace(/-+$/, "");
}

export function parseCsvList(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return parsed.length > 0 ? parsed : undefined;
}

export function isIpv4Address(value: string): boolean {
  const octets = value.split(".");
  if (octets.length !== 4) {
    return false;
  }

  return octets.every((octet) => {
    if (!/^\d+$/.test(octet)) {
      return false;
    }
    const parsed = Number(octet);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255;
  });
}

export function isCloudflareR2Endpoint(endpoint: string): boolean {
  try {
    const parsedUrl = new URL(endpoint);
    return parsedUrl.hostname.endsWith(".r2.cloudflarestorage.com");
  } catch {
    return endpoint.endsWith(".r2.cloudflarestorage.com");
  }
}

export function truncateK8sName(value: string): string {
  return value.slice(0, 63).replace(/-+$/, "");
}

export function resolveHelmFullname(input: HelmNameInput): string {
  if (input.fullnameOverride !== undefined && input.fullnameOverride.length > 0) {
    return truncateK8sName(input.fullnameOverride);
  }

  const effectiveChartName = input.nameOverride ?? input.chartName;
  if (input.releaseName.includes(effectiveChartName)) {
    return truncateK8sName(input.releaseName);
  }
  return truncateK8sName(`${input.releaseName}-${effectiveChartName}`);
}

export function resolveIngressLoadBalancerTarget(status: unknown): string {
  if (!isRecord(status)) {
    throw new Error(
      "Ingress status is unavailable. Set cloudflareRecordTarget explicitly or wait for ingress to receive a load balancer address.",
    );
  }

  const loadBalancer = isRecord(status["loadBalancer"]) ? status["loadBalancer"] : null;
  const ingress =
    loadBalancer !== null && Array.isArray(loadBalancer["ingress"]) ? loadBalancer["ingress"] : [];

  if (ingress.length === 0) {
    throw new Error(
      "Ingress has no load balancer address yet. Set cloudflareRecordTarget explicitly or rerun deploy after ingress reconciliation.",
    );
  }

  for (const entry of ingress) {
    if (isRecord(entry) && typeof entry["hostname"] === "string" && entry["hostname"].length > 0) {
      return entry["hostname"];
    }
  }

  for (const entry of ingress) {
    if (isRecord(entry) && typeof entry["ip"] === "string" && entry["ip"].length > 0) {
      return entry["ip"];
    }
  }

  throw new Error(
    "Ingress load balancer entries did not include hostname or ip. Set cloudflareRecordTarget explicitly.",
  );
}

export function resolveCloudflareRecordSpec(
  targetOverride: string | undefined,
  ingressStatus: unknown,
): { type: "A" | "CNAME"; content: string } {
  const target = targetOverride ?? resolveIngressLoadBalancerTarget(ingressStatus);
  return isIpv4Address(target)
    ? { type: "A", content: target }
    : { type: "CNAME", content: target };
}
