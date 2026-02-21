import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const chartName = "openerrata";
const releaseName = config.get("releaseName") ?? chartName;
const nameOverride = config.get("nameOverride") ?? undefined;
const fullnameOverride = config.get("fullnameOverride") ?? undefined;

function truncateK8sName(value: string): string {
  return value.slice(0, 63).replace(/-+$/, "");
}

function resolveHelmFullname(input: {
  releaseName: string;
  chartName: string;
  nameOverride: string | undefined;
  fullnameOverride: string | undefined;
}): string {
  if (input.fullnameOverride) {
    return truncateK8sName(input.fullnameOverride);
  }

  const effectiveChartName = input.nameOverride ?? input.chartName;
  if (input.releaseName.includes(effectiveChartName)) {
    return truncateK8sName(input.releaseName);
  }
  return truncateK8sName(`${input.releaseName}-${effectiveChartName}`);
}

const chart = new k8s.helm.v3.Chart(releaseName, {
  path: "../../helm/openerrata",
  values: {
    ...(nameOverride ? { nameOverride } : {}),
    ...(fullnameOverride ? { fullnameOverride } : {}),
    replicaCount: {
      api: config.getNumber("apiReplicas") ?? 2,
      worker: config.getNumber("workerReplicas") ?? 2,
    },
    image: {
      repository: config.get("imageRepository") ?? "ghcr.io/zeropathAI/openerrata-api",
      tag: config.get("imageTag") ?? "latest",
    },
    selector: {
      budget: config.get("selectorBudget") ?? "100",
    },
    config: {
      ipRangeCreditCap: config.get("ipRangeCreditCap") ?? "10",
      databaseEncryptionKeyId: config.get("databaseEncryptionKeyId") ?? "primary",
      blobStorageEndpoint: config.get("blobStorageEndpoint") ?? "",
      blobStorageBucket: config.require("blobStorageBucket"),
      blobStoragePublicUrlPrefix: config.require("blobStoragePublicUrlPrefix"),
    },
    secrets: {
      databaseUrl: config.requireSecret("databaseUrl"),
      openaiApiKey: config.requireSecret("openaiApiKey"),
      validApiKeys: config.requireSecret("validApiKeys"),
      hmacSecret: config.requireSecret("hmacSecret"),
      databaseEncryptionKey: config.requireSecret("databaseEncryptionKey"),
      blobStorageAccessKeyId: config.requireSecret("blobStorageAccessKeyId"),
      blobStorageSecretAccessKey: config.requireSecret("blobStorageSecretAccessKey"),
    },
  },
});

const fullname = resolveHelmFullname({
  releaseName,
  chartName,
  nameOverride,
  fullnameOverride,
});

export const apiServiceName = chart
  .getResourceProperty("v1/Service", `${fullname}-api`, "metadata")
  .apply((m) => m.name);
