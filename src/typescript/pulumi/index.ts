import * as aws from "@pulumi/aws";
import * as cloudflare from "@pulumi/cloudflare";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import {
  isCloudflareR2Endpoint,
  normalizeDnsCompatibleComponent,
  parseCsvList,
  resolveCloudflareRecordSpec,
  resolveHelmFullname,
  truncateName,
} from "./lib/config-helpers.js";

const config = new pulumi.Config();
const defaultImageRepository = "ghcr.io/zeropathai/openerrata-api";
const defaultFrontendImageRepository = "ghcr.io/zeropathai/openerrata-frontend";
const chartName = "openerrata";
const releaseName = config.get("releaseName") ?? chartName;
const namespaceName =
  config.get("namespace") ?? `openerrata-${normalizeDnsCompatibleComponent(pulumi.getStack())}`;
const nameOverride = config.get("nameOverride") ?? undefined;
const fullnameOverride = config.get("fullnameOverride") ?? undefined;

/** Chart `image` values: a digest, when set, takes precedence over the tag. */
type ImageConfig = { repository: string } & (
  | { tag: string; digest?: string }
  | { tag?: string; digest: string }
);

type BlobStorageProvider = "aws" | "s3_compatible";

interface BlobStorageConfigBase {
  mode: "manual" | "managed_aws";
  provider: BlobStorageProvider;
  region: string;
  bucket: pulumi.Input<string>;
  accessKeyId: pulumi.Input<string>;
  secretAccessKey: pulumi.Input<string>;
}

type AwsBlobStorageConfig = BlobStorageConfigBase & {
  provider: "aws";
  endpoint: undefined;
};

type S3CompatibleBlobStorageConfig = BlobStorageConfigBase & {
  provider: "s3_compatible";
  endpoint: string;
};

type BlobStorageConfig = AwsBlobStorageConfig | S3CompatibleBlobStorageConfig;

interface ManagedDatabaseSettings {
  publiclyAccessible: boolean;
  ingressCidrs: string[];
  engineVersion: string;
}

type DatabaseSettings =
  | { mode: "manual"; databaseUrl: pulumi.Output<string> }
  | { mode: "managed_aws_rds"; managed: ManagedDatabaseSettings };

type DatabaseConfig =
  | { mode: "manual"; databaseUrl: pulumi.Input<string> }
  | { mode: "managed_aws_rds"; databaseUrl: pulumi.Input<string>; endpoint: pulumi.Output<string> };

type FrontendConfig =
  | { mode: "disabled" }
  | { mode: "enabled"; image: ImageConfig; ingress: FrontendIngressConfig };

type FrontendIngressConfig =
  | {
      mode: "disabled";
    }
  | {
      mode: "enabled";
      host: string;
      className: string;
      path: string;
    };

type ApiIngressConfig =
  | {
      mode: "disabled";
    }
  | {
      mode: "enabled";
      host: string;
      className: string;
      path: string;
    };

type DnsConfig =
  | {
      provider: "none";
    }
  | {
      provider: "cloudflare";
      zoneId: string;
      proxied: boolean;
      targetOverride: string | undefined;
    };

function getNonEmptyConfig(input: pulumi.Config, key: string): string | undefined {
  const value = input.get(key);
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Reads `<prefix>Repository`, `<prefix>Tag` and `<prefix>Digest` (CI sets all three). */
function resolveImageConfig(
  input: pulumi.Config,
  prefix: "image" | "frontendImage",
  defaultRepository: string,
): ImageConfig {
  const repository = getNonEmptyConfig(input, `${prefix}Repository`) ?? defaultRepository;
  if (/[A-Z]/.test(repository)) {
    throw new Error(
      `${prefix}Repository must be lowercase for OCI compatibility, got: ${repository}`,
    );
  }

  const tag = getNonEmptyConfig(input, `${prefix}Tag`);
  const digest = getNonEmptyConfig(input, `${prefix}Digest`);
  if (digest !== undefined) {
    return { repository, digest, ...(tag !== undefined ? { tag } : {}) };
  }
  if (tag !== undefined) {
    return { repository, tag };
  }
  throw new Error(`${prefix}Tag or ${prefix}Digest is required.`);
}

function createManagedAwsBlobStorage(input: pulumi.Config): BlobStorageConfig {
  const configuredManagedBucketName = getNonEmptyConfig(input, "managedBlobStorageBucketName");
  const managedBlobStorageForceDestroy =
    input.getBoolean("managedBlobStorageForceDestroy") ?? false;

  const projectComponent = normalizeDnsCompatibleComponent(pulumi.getProject());
  const stackComponent = normalizeDnsCompatibleComponent(pulumi.getStack());
  const bucketPrefix = truncateName(`${projectComponent}-${stackComponent}`, 44);

  const accountIdentity = aws.getCallerIdentityOutput();
  const derivedBucketName = pulumi.interpolate`${bucketPrefix}-${accountIdentity.accountId}-blobs`;

  const bucket = new aws.s3.Bucket("blob-storage", {
    bucket: configuredManagedBucketName ?? derivedBucketName,
    forceDestroy: managedBlobStorageForceDestroy,
    tags: {
      managedBy: "pulumi",
      project: pulumi.getProject(),
      stack: pulumi.getStack(),
    },
  });

  // Blobs are private: the API only writes them (images reach the model
  // inline), and nothing reads them by public URL.
  new aws.s3.BucketPublicAccessBlock("blob-storage-public-access", {
    bucket: bucket.id,
    blockPublicAcls: true,
    ignorePublicAcls: true,
    blockPublicPolicy: true,
    restrictPublicBuckets: true,
  });

  new aws.s3.BucketOwnershipControls("blob-storage-ownership", {
    bucket: bucket.id,
    rule: {
      objectOwnership: "BucketOwnerPreferred",
    },
  });

  const blobWriterUser = new aws.iam.User("blob-storage-writer", {
    forceDestroy: managedBlobStorageForceDestroy,
    tags: {
      managedBy: "pulumi",
      project: pulumi.getProject(),
      stack: pulumi.getStack(),
    },
  });

  new aws.iam.UserPolicy("blob-storage-writer-policy", {
    user: blobWriterUser.name,
    policy: bucket.arn.apply((bucketArn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "BucketList",
            Effect: "Allow",
            Action: ["s3:ListBucket"],
            Resource: [bucketArn],
          },
          {
            Sid: "ObjectReadWrite",
            Effect: "Allow",
            Action: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
            Resource: [`${bucketArn}/*`],
          },
        ],
      }),
    ),
  });

  const blobWriterAccessKey = new aws.iam.AccessKey("blob-storage-writer-access-key", {
    user: blobWriterUser.name,
    // The API uploads with this key; a key deactivated out of band (as
    // staging's was) is reactivated on the next refreshing deploy.
    status: "Active",
  });

  const awsRegion = aws.config.region;
  if (awsRegion === undefined || awsRegion.length === 0) {
    throw new Error(
      "AWS region must be configured for managed blob storage (e.g. `pulumi config set aws:region us-west-2`).",
    );
  }

  return {
    mode: "managed_aws",
    provider: "aws",
    region: awsRegion,
    endpoint: undefined,
    bucket: bucket.bucket,
    accessKeyId: blobWriterAccessKey.id,
    secretAccessKey: blobWriterAccessKey.secret,
  };
}

function resolveBlobStorage(input: pulumi.Config): BlobStorageConfig {
  const configuredBucket = getNonEmptyConfig(input, "blobStorageBucket");
  const configuredAccessKeyId = getNonEmptyConfig(input, "blobStorageAccessKeyId");
  const configuredSecretAccessKey = input.getSecret("blobStorageSecretAccessKey");

  const manualFieldsProvidedCount = [
    configuredBucket,
    configuredAccessKeyId,
    configuredSecretAccessKey,
  ].filter((value) => value !== undefined).length;
  const configuredProvider = getNonEmptyConfig(input, "blobStorageProvider");
  const configuredEndpoint = getNonEmptyConfig(input, "blobStorageEndpoint");
  const configuredRegion = getNonEmptyConfig(input, "blobStorageRegion");

  if (manualFieldsProvidedCount === 0) {
    return createManagedAwsBlobStorage(input);
  }

  if (
    configuredBucket === undefined ||
    configuredAccessKeyId === undefined ||
    configuredSecretAccessKey === undefined
  ) {
    throw new Error(
      "Manual blob storage configuration requires blobStorageBucket, blobStorageAccessKeyId, " +
        "and blobStorageSecretAccessKey together.",
    );
  }

  let resolvedProvider: BlobStorageProvider;
  if (configuredProvider === undefined) {
    resolvedProvider = configuredEndpoint === undefined ? "aws" : "s3_compatible";
  } else if (configuredProvider === "aws" || configuredProvider === "s3_compatible") {
    resolvedProvider = configuredProvider;
  } else {
    throw new Error("blobStorageProvider must be either 'aws' or 's3_compatible' when provided.");
  }

  if (resolvedProvider === "aws") {
    if (configuredEndpoint !== undefined) {
      throw new Error("blobStorageEndpoint must be unset when blobStorageProvider is 'aws'.");
    }

    const resolvedRegion = configuredRegion ?? aws.config.region;
    if (resolvedRegion === undefined || resolvedRegion.length === 0) {
      throw new Error(
        "blobStorageRegion is required when blobStorageProvider is 'aws' and no aws:region is configured.",
      );
    }
    if (resolvedRegion.toLowerCase() === "auto") {
      throw new Error("blobStorageRegion cannot be 'auto' when blobStorageProvider is 'aws'.");
    }

    return {
      mode: "manual",
      provider: "aws",
      region: resolvedRegion,
      endpoint: undefined,
      bucket: configuredBucket,
      accessKeyId: configuredAccessKeyId,
      secretAccessKey: configuredSecretAccessKey,
    };
  }

  if (configuredEndpoint === undefined) {
    throw new Error("blobStorageEndpoint is required when blobStorageProvider is 's3_compatible'.");
  }

  const resolvedS3CompatibleRegion =
    configuredRegion ?? (isCloudflareR2Endpoint(configuredEndpoint) ? "auto" : undefined);
  if (resolvedS3CompatibleRegion === undefined || resolvedS3CompatibleRegion.length === 0) {
    throw new Error(
      "blobStorageRegion is required when blobStorageProvider is 's3_compatible' unless blobStorageEndpoint targets Cloudflare R2.",
    );
  }

  return {
    mode: "manual",
    provider: "s3_compatible",
    region: resolvedS3CompatibleRegion,
    endpoint: configuredEndpoint,
    bucket: configuredBucket,
    accessKeyId: configuredAccessKeyId,
    secretAccessKey: configuredSecretAccessKey,
  };
}

/**
 * Network exposure and engine version of the managed database have no
 * defaults: changing either on an existing instance can cut off the cluster or
 * trigger an upgrade, so every stack states them explicitly.
 */
function readManagedDatabaseSettings(input: pulumi.Config): ManagedDatabaseSettings {
  const ingressCidrs = parseCsvList(getNonEmptyConfig(input, "managedDatabaseIngressCidrs"));
  if (ingressCidrs === undefined) {
    throw new Error(
      "managedDatabaseIngressCidrs is required for the managed database (comma-separated CIDRs allowed to reach Postgres).",
    );
  }
  const engineVersion = getNonEmptyConfig(input, "managedDatabaseEngineVersion");
  if (engineVersion === undefined) {
    throw new Error(
      "managedDatabaseEngineVersion is required for the managed database (e.g. 17; for an existing instance, its current major version).",
    );
  }
  return {
    publiclyAccessible: input.requireBoolean("managedDatabasePubliclyAccessible"),
    ingressCidrs,
    engineVersion,
  };
}

function readDatabaseSettings(input: pulumi.Config): DatabaseSettings {
  const configuredDatabaseUrl = input.getSecret("databaseUrl");
  if (configuredDatabaseUrl !== undefined) {
    return { mode: "manual", databaseUrl: configuredDatabaseUrl };
  }
  return { mode: "managed_aws_rds", managed: readManagedDatabaseSettings(input) };
}

function createManagedAwsDatabase(
  input: pulumi.Config,
  settings: ManagedDatabaseSettings,
): DatabaseConfig {
  const configuredVpcId = getNonEmptyConfig(input, "managedDatabaseVpcId");
  const configuredSubnetIds = parseCsvList(getNonEmptyConfig(input, "managedDatabaseSubnetIds"));
  const configuredIdentifier = getNonEmptyConfig(input, "managedDatabaseIdentifier");

  const databaseName = getNonEmptyConfig(input, "managedDatabaseName") ?? "openerrata";
  const databaseUsername = getNonEmptyConfig(input, "managedDatabaseUsername") ?? "openerrata";
  const databaseInstanceClass =
    getNonEmptyConfig(input, "managedDatabaseInstanceClass") ?? "db.t3.micro";
  const databaseAllocatedStorage = input.getNumber("managedDatabaseAllocatedStorage") ?? 20;
  const databaseMaxAllocatedStorage = input.getNumber("managedDatabaseMaxAllocatedStorage") ?? 100;
  const databaseMultiAz = input.getBoolean("managedDatabaseMultiAz") ?? false;
  const databaseBackupRetentionPeriod =
    input.getNumber("managedDatabaseBackupRetentionPeriod") ?? 7;
  const databaseDeletionProtection =
    input.getBoolean("managedDatabaseDeletionProtection") ?? pulumi.getStack() === "main";
  const databaseSkipFinalSnapshot =
    input.getBoolean("managedDatabaseSkipFinalSnapshot") ?? !databaseDeletionProtection;
  const databaseApplyImmediately = input.getBoolean("managedDatabaseApplyImmediately") ?? true;

  const projectComponent = normalizeDnsCompatibleComponent(pulumi.getProject());
  const stackComponent = normalizeDnsCompatibleComponent(pulumi.getStack());
  const accountIdentity = aws.getCallerIdentityOutput();
  const identifierPrefix = truncateName(`${projectComponent}-${stackComponent}`, 32);
  const derivedIdentifier = pulumi.interpolate`${identifierPrefix}-${accountIdentity.accountId}-db`;
  const databaseIdentifier = configuredIdentifier ?? derivedIdentifier;

  const vpcId: pulumi.Input<string> = configuredVpcId ?? aws.ec2.getVpcOutput({ default: true }).id;

  const subnetIds: pulumi.Input<string[]> =
    configuredSubnetIds ??
    aws.ec2.getSubnetsOutput({
      filters: [
        {
          name: "vpc-id",
          values: [vpcId],
        },
      ],
    }).ids;

  const subnetGroup = new aws.rds.SubnetGroup("database-subnet-group", {
    subnetIds,
    tags: {
      managedBy: "pulumi",
      project: pulumi.getProject(),
      stack: pulumi.getStack(),
    },
  });

  const securityGroup = new aws.ec2.SecurityGroup("database-security-group", {
    vpcId,
    description: "OpenErrata managed Postgres access",
    ingress: settings.ingressCidrs.map((cidr) => ({
      protocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      cidrBlocks: [cidr],
    })),
    egress: [
      {
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
      },
    ],
    tags: {
      managedBy: "pulumi",
      project: pulumi.getProject(),
      stack: pulumi.getStack(),
    },
  });

  const databasePassword = new random.RandomPassword("database-password", {
    length: 32,
    special: false,
  }).result;

  const database = new aws.rds.Instance("database", {
    identifier: databaseIdentifier,
    engine: "postgres",
    engineVersion: settings.engineVersion,
    instanceClass: databaseInstanceClass,
    allocatedStorage: databaseAllocatedStorage,
    maxAllocatedStorage: databaseMaxAllocatedStorage,
    dbName: databaseName,
    username: databaseUsername,
    password: databasePassword,
    port: 5432,
    dbSubnetGroupName: subnetGroup.name,
    vpcSecurityGroupIds: [securityGroup.id],
    publiclyAccessible: settings.publiclyAccessible,
    multiAz: databaseMultiAz,
    backupRetentionPeriod: databaseBackupRetentionPeriod,
    deletionProtection: databaseDeletionProtection,
    skipFinalSnapshot: databaseSkipFinalSnapshot,
    applyImmediately: databaseApplyImmediately,
    autoMinorVersionUpgrade: true,
    deleteAutomatedBackups: true,
    storageEncrypted: true,
    tags: {
      managedBy: "pulumi",
      project: pulumi.getProject(),
      stack: pulumi.getStack(),
    },
  });

  const databaseUrl = pulumi.secret(
    pulumi.interpolate`postgresql://${databaseUsername}:${databasePassword}@${database.address}:${database.port}/${databaseName}?sslmode=require`,
  );

  return {
    mode: "managed_aws_rds",
    databaseUrl,
    endpoint: pulumi.interpolate`${database.address}:${database.port}`,
  };
}

function provisionDatabase(input: pulumi.Config, settings: DatabaseSettings): DatabaseConfig {
  return settings.mode === "manual" ? settings : createManagedAwsDatabase(input, settings.managed);
}

function resolveApiIngress(input: pulumi.Config): ApiIngressConfig {
  const configuredHost = getNonEmptyConfig(input, "apiHostname");
  const configuredIngressEnabled = input.getBoolean("ingressEnabled");

  if (configuredHost === undefined) {
    if (configuredIngressEnabled === true) {
      throw new Error("ingressEnabled=true requires apiHostname to be configured.");
    }
    return { mode: "disabled" };
  }

  const ingressEnabled = configuredIngressEnabled ?? true;
  if (!ingressEnabled) {
    return { mode: "disabled" };
  }

  return {
    mode: "enabled",
    host: configuredHost,
    className: getNonEmptyConfig(input, "ingressClassName") ?? "nginx",
    path: getNonEmptyConfig(input, "ingressPath") ?? "/",
  };
}

function resolveDns(input: pulumi.Config): DnsConfig {
  const configuredProvider = (getNonEmptyConfig(input, "dnsProvider") ?? "none")
    .toLowerCase()
    .trim();

  if (configuredProvider === "none") {
    return { provider: "none" };
  }

  if (configuredProvider === "cloudflare") {
    const zoneId = getNonEmptyConfig(input, "cloudflareZoneId");
    if (zoneId === undefined) {
      throw new Error("dnsProvider=cloudflare requires cloudflareZoneId.");
    }

    return {
      provider: "cloudflare",
      zoneId,
      proxied: input.getBoolean("cloudflareProxied") ?? true,
      targetOverride: getNonEmptyConfig(input, "cloudflareRecordTarget"),
    };
  }

  throw new Error(
    `Unsupported dnsProvider '${configuredProvider}'. Supported values: none, cloudflare.`,
  );
}

function resolveSecretWithRandom(
  input: pulumi.Config,
  configKey: string,
  resourceName: string,
): pulumi.Input<string> {
  const configuredSecret = input.getSecret(configKey);
  if (configuredSecret !== undefined) {
    return configuredSecret;
  }

  return new random.RandomPassword(resourceName, {
    length: 64,
    special: false,
  }).result;
}

function resolveFrontendIngress(input: pulumi.Config): FrontendIngressConfig {
  const configuredHost = getNonEmptyConfig(input, "frontendHostname");
  const configuredEnabled = input.getBoolean("frontendIngressEnabled");

  if (configuredHost === undefined) {
    if (configuredEnabled === true) {
      throw new Error("frontendIngressEnabled=true requires frontendHostname to be configured.");
    }
    return { mode: "disabled" };
  }

  const ingressEnabled = configuredEnabled ?? true;
  if (!ingressEnabled) {
    return { mode: "disabled" };
  }

  return {
    mode: "enabled",
    host: configuredHost,
    className: getNonEmptyConfig(input, "frontendIngressClassName") ?? "nginx",
    path: getNonEmptyConfig(input, "frontendIngressPath") ?? "/",
  };
}

function resolveFrontend(input: pulumi.Config): FrontendConfig {
  if (input.getBoolean("frontendEnabled") !== true) {
    return { mode: "disabled" };
  }
  return {
    mode: "enabled",
    image: resolveImageConfig(input, "frontendImage", defaultFrontendImageRepository),
    ingress: resolveFrontendIngress(input),
  };
}

/** Chart values a stack may override; unset keys are omitted so the chart's defaults apply. */
function configuredValues(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

// Read and validate all configuration before any resource is registered.
const image = resolveImageConfig(config, "image", defaultImageRepository);
const databaseSettings = readDatabaseSettings(config);
const frontend = resolveFrontend(config);
const apiIngress = resolveApiIngress(config);
const dns = resolveDns(config);
const openaiApiKey = config.requireSecret("openaiApiKey");
const workerEgressAllowedCidrs = parseCsvList(
  getNonEmptyConfig(config, "workerEgressAllowedCidrs"),
);

const blobStorage = resolveBlobStorage(config);
const database = provisionDatabase(config, databaseSettings);
const resolvedDatabaseEncryptionKey = resolveSecretWithRandom(
  config,
  "databaseEncryptionKey",
  "generated-database-encryption-key",
);

if (dns.provider === "cloudflare" && apiIngress.mode !== "enabled") {
  throw new Error("dnsProvider=cloudflare requires ingress with apiHostname.");
}

// The namespace is expected to be pre-created by the cluster admin (see
// src/kubernetes/ci-rbac/setup.sh) so the CI deploy group's RBAC can be
// scoped to it.  `import: true` tells Pulumi to adopt an existing namespace
// rather than failing with a conflict.
const namespace = new k8s.core.v1.Namespace(
  "namespace",
  {
    metadata: { name: namespaceName },
  },
  { import: namespaceName },
);

const fullname = resolveHelmFullname({
  releaseName,
  chartName,
  nameOverride,
  fullnameOverride,
});

// `selectorBudget` used to cap each 5-minute selector run; the cap is now per
// UTC day under a different key. Refuse the old key rather than silently
// reinterpreting a value chosen for the old meaning.
if (config.get("selectorBudget") !== undefined) {
  throw new Error(
    "Pulumi config `selectorBudget` was replaced by `selectorDailyBudget` (investigations the selector admits per UTC day). Remove `selectorBudget` and set `selectorDailyBudget` if the default of 100 does not fit.",
  );
}
const selectorDailyBudget = config.get("selectorDailyBudget") ?? "100";

const chart = new k8s.helm.v3.Chart(
  releaseName,
  {
    path: "../../helm/openerrata",
    namespace: namespaceName,
    values: {
      ...(nameOverride !== undefined && nameOverride.length > 0 ? { nameOverride } : {}),
      ...(fullnameOverride !== undefined && fullnameOverride.length > 0
        ? { fullnameOverride }
        : {}),
      replicaCount: configuredValues({
        api: config.getNumber("apiReplicas"),
        worker: config.getNumber("workerReplicas"),
      }),
      image,
      selector: {
        dailyBudget: selectorDailyBudget,
      },
      ...(frontend.mode === "enabled"
        ? {
            frontend: {
              enabled: true,
              ...configuredValues({ replicaCount: config.getNumber("frontendReplicas") }),
              apiBaseUrl:
                apiIngress.mode === "enabled"
                  ? `https://${apiIngress.host}`
                  : `http://${fullname}-api.${namespaceName}.svc.cluster.local:3000`,
              image: frontend.image,
              ...(frontend.ingress.mode === "enabled"
                ? {
                    ingress: {
                      enabled: true,
                      className: frontend.ingress.className,
                      host: frontend.ingress.host,
                      path: frontend.ingress.path,
                    },
                  }
                : {
                    ingress: {
                      enabled: false,
                    },
                  }),
            },
          }
        : {}),
      ...(apiIngress.mode === "enabled"
        ? {
            ingress: {
              enabled: true,
              className: apiIngress.className,
              host: apiIngress.host,
              path: apiIngress.path,
            },
          }
        : {
            ingress: {
              enabled: false,
            },
          }),
      networkPolicy: {
        workerEgress: configuredValues({
          enabled: config.getBoolean("workerEgressPolicyEnabled"),
          allowedCidrs: workerEgressAllowedCidrs,
        }),
      },
      config: {
        ...configuredValues({
          ipRangeCreditCap: config.get("ipRangeCreditCap"),
          workerConcurrency: config.get("workerConcurrency"),
          openaiMaxResponseToolRounds: config.get("openaiMaxResponseToolRounds"),
          databaseEncryptionKeyId: config.get("databaseEncryptionKeyId"),
        }),
        blobStorageProvider: blobStorage.provider,
        blobStorageRegion: blobStorage.region,
        blobStorageEndpoint: blobStorage.endpoint ?? "",
        blobStorageBucket: blobStorage.bucket,
      },
      secrets: {
        databaseUrl: database.databaseUrl,
        openaiApiKey,
        databaseEncryptionKey: resolvedDatabaseEncryptionKey,
        blobStorageAccessKeyId: blobStorage.accessKeyId,
        blobStorageSecretAccessKey: blobStorage.secretAccessKey,
      },
    },
  },
  { dependsOn: [namespace] },
);

if (
  dns.provider === "cloudflare" &&
  frontend.mode === "enabled" &&
  frontend.ingress.mode === "enabled"
) {
  const frontendHost = frontend.ingress.host;
  const frontendRecordSpec: pulumi.Output<{ type: "A" | "CNAME"; content: string }> =
    dns.targetOverride !== undefined
      ? pulumi.output(resolveCloudflareRecordSpec(dns.targetOverride, undefined))
      : chart
          .getResourceProperty(
            "networking.k8s.io/v1/Ingress",
            namespaceName,
            `${fullname}-frontend`,
            "status",
          )
          .apply((status) => resolveCloudflareRecordSpec(undefined, status));

  new cloudflare.DnsRecord("frontend-dns", {
    zoneId: dns.zoneId,
    name: frontendHost,
    type: frontendRecordSpec.apply((spec) => spec.type),
    content: frontendRecordSpec.apply((spec) => spec.content),
    proxied: dns.proxied,
    ttl: dns.proxied ? 1 : 300,
    comment: `Managed by Pulumi (${pulumi.getProject()}/${pulumi.getStack()})`,
  });
}

if (dns.provider === "cloudflare" && apiIngress.mode === "enabled") {
  const cloudflareRecordSpec: pulumi.Output<{ type: "A" | "CNAME"; content: string }> =
    dns.targetOverride !== undefined
      ? pulumi.output(resolveCloudflareRecordSpec(dns.targetOverride, undefined))
      : chart
          .getResourceProperty(
            "networking.k8s.io/v1/Ingress",
            namespaceName,
            `${fullname}-api`,
            "status",
          )
          .apply((status) => resolveCloudflareRecordSpec(undefined, status));

  new cloudflare.DnsRecord("api-cloudflare-dns", {
    zoneId: dns.zoneId,
    name: apiIngress.host,
    type: cloudflareRecordSpec.apply((spec) => spec.type),
    content: cloudflareRecordSpec.apply((spec) => spec.content),
    proxied: dns.proxied,
    ttl: dns.proxied ? 1 : 300,
    comment: `Managed by Pulumi (${pulumi.getProject()}/${pulumi.getStack()})`,
  });
}

export const frontendServiceName = frontend.mode === "enabled" ? `${fullname}-frontend` : undefined;
export const frontendHostname =
  frontend.mode === "enabled" && frontend.ingress.mode === "enabled"
    ? frontend.ingress.host
    : undefined;
export const apiServiceName = pulumi.output(`${fullname}-api`);
export const kubernetesNamespace = namespaceName;
export const apiHostname = apiIngress.mode === "enabled" ? apiIngress.host : undefined;
export const dnsProvider = dns.provider;

export const blobStorageMode = blobStorage.mode;
export const blobStorageBucketName = blobStorage.bucket;
export const databaseMode = database.mode;
export const databaseEndpoint = database.mode === "managed_aws_rds" ? database.endpoint : undefined;
