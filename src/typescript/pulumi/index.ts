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
const defaultBlobStorageAccessKeyId = "openerrata";
const chartName = "openerrata";
const releaseName = config.get("releaseName") ?? chartName;
const namespaceName =
  config.get("namespace") ?? `openerrata-${normalizeDnsCompatibleComponent(pulumi.getStack())}`;
const nameOverride = config.get("nameOverride") ?? undefined;
const fullnameOverride = config.get("fullnameOverride") ?? undefined;

interface ImageConfig {
  repository: string;
  tag: string;
  digest: string | undefined;
}

type BlobStorageProvider = "aws" | "s3_compatible";

interface BlobStorageConfigBase {
  mode: "manual" | "managed_aws";
  provider: BlobStorageProvider;
  region: string;
  bucket: pulumi.Input<string>;
  publicUrlPrefix: pulumi.Input<string>;
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

interface DatabaseConfig {
  mode: "manual" | "managed_aws_rds";
  databaseUrl: pulumi.Input<string>;
  endpoint: pulumi.Input<string>;
}

interface FrontendImageConfig {
  repository: string;
  tag: string;
  digest: string | undefined;
}

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

function getNonEmptyEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getNonEmptyConfig(input: pulumi.Config, key: string): string | undefined {
  const value = input.get(key);
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveImageConfig(input: pulumi.Config): ImageConfig {
  const configuredRepository =
    getNonEmptyConfig(input, "imageRepository") ?? defaultImageRepository;
  const configuredTag = getNonEmptyConfig(input, "imageTag") ?? "latest";
  const configuredDigest = getNonEmptyConfig(input, "imageDigest");

  const ciRepository = getNonEmptyEnv("CI_IMAGE_REPOSITORY");
  const ciTag = getNonEmptyEnv("CI_IMAGE_TAG");
  const ciDigest = getNonEmptyEnv("CI_IMAGE_DIGEST");

  const resolvedRepository = ciRepository ?? configuredRepository;
  if (/[A-Z]/.test(resolvedRepository)) {
    throw new Error(
      `imageRepository must be lowercase for OCI compatibility, got: ${resolvedRepository}`,
    );
  }

  return {
    repository: resolvedRepository,
    tag: ciTag ?? configuredTag,
    digest: ciDigest ?? configuredDigest,
  };
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

  const publicAccessBlock = new aws.s3.BucketPublicAccessBlock("blob-storage-public-access", {
    bucket: bucket.id,
    blockPublicAcls: false,
    ignorePublicAcls: false,
    blockPublicPolicy: false,
    restrictPublicBuckets: false,
  });

  new aws.s3.BucketOwnershipControls("blob-storage-ownership", {
    bucket: bucket.id,
    rule: {
      objectOwnership: "BucketOwnerPreferred",
    },
  });

  new aws.s3.BucketPolicy(
    "blob-storage-public-read-policy",
    {
      bucket: bucket.id,
      policy: bucket.arn.apply((bucketArn) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "PublicReadImages",
              Effect: "Allow",
              Principal: "*",
              Action: ["s3:GetObject"],
              Resource: [`${bucketArn}/images/*`],
            },
          ],
        }),
      ),
    },
    { dependsOn: [publicAccessBlock] },
  );

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
    publicUrlPrefix: pulumi.interpolate`https://${bucket.bucketRegionalDomainName}`,
    accessKeyId: blobWriterAccessKey.id,
    secretAccessKey: blobWriterAccessKey.secret,
  };
}

function resolveBlobStorage(input: pulumi.Config): BlobStorageConfig {
  const configuredBucket = getNonEmptyConfig(input, "blobStorageBucket");
  const configuredPublicUrlPrefix = getNonEmptyConfig(input, "blobStoragePublicUrlPrefix");
  const configuredSecretAccessKey = input.getSecret("blobStorageSecretAccessKey");

  const hasConfiguredBucket = configuredBucket !== undefined;
  const hasConfiguredPublicUrlPrefix = configuredPublicUrlPrefix !== undefined;
  const hasConfiguredSecretAccessKey = configuredSecretAccessKey !== undefined;
  const manualFieldsProvidedCount = [
    hasConfiguredBucket,
    hasConfiguredPublicUrlPrefix,
    hasConfiguredSecretAccessKey,
  ].filter(Boolean).length;
  const configuredProvider = getNonEmptyConfig(input, "blobStorageProvider");
  const configuredEndpoint = getNonEmptyConfig(input, "blobStorageEndpoint");
  const configuredRegion = getNonEmptyConfig(input, "blobStorageRegion");

  if (manualFieldsProvidedCount === 0) {
    return createManagedAwsBlobStorage(input);
  }

  if (manualFieldsProvidedCount !== 3) {
    throw new Error(
      "Manual blob storage configuration requires blobStorageBucket, " +
        "blobStoragePublicUrlPrefix, and blobStorageSecretAccessKey together.",
    );
  }

  if (
    configuredBucket === undefined ||
    configuredPublicUrlPrefix === undefined ||
    configuredSecretAccessKey === undefined
  ) {
    throw new Error("Manual blob storage configuration was expected but could not be resolved.");
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
      publicUrlPrefix: configuredPublicUrlPrefix,
      accessKeyId:
        getNonEmptyConfig(input, "blobStorageAccessKeyId") ?? defaultBlobStorageAccessKeyId,
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
    publicUrlPrefix: configuredPublicUrlPrefix,
    accessKeyId:
      getNonEmptyConfig(input, "blobStorageAccessKeyId") ?? defaultBlobStorageAccessKeyId,
    secretAccessKey: configuredSecretAccessKey,
  };
}

function createManagedAwsDatabase(input: pulumi.Config): DatabaseConfig {
  const configuredVpcId = getNonEmptyConfig(input, "managedDatabaseVpcId");
  const configuredSubnetIds = parseCsvList(getNonEmptyConfig(input, "managedDatabaseSubnetIds"));
  const configuredIngressCidrs = parseCsvList(
    getNonEmptyConfig(input, "managedDatabaseIngressCidrs"),
  );
  const configuredIdentifier = getNonEmptyConfig(input, "managedDatabaseIdentifier");

  const databaseName = getNonEmptyConfig(input, "managedDatabaseName") ?? "openerrata";
  const databaseUsername = getNonEmptyConfig(input, "managedDatabaseUsername") ?? "openerrata";
  const databaseInstanceClass =
    getNonEmptyConfig(input, "managedDatabaseInstanceClass") ?? "db.t3.micro";
  const databaseAllocatedStorage = input.getNumber("managedDatabaseAllocatedStorage") ?? 20;
  const databaseMaxAllocatedStorage = input.getNumber("managedDatabaseMaxAllocatedStorage") ?? 100;
  const databasePubliclyAccessible = input.getBoolean("managedDatabasePubliclyAccessible") ?? true;
  const databaseMultiAz = input.getBoolean("managedDatabaseMultiAz") ?? false;
  const databaseBackupRetentionPeriod =
    input.getNumber("managedDatabaseBackupRetentionPeriod") ?? 7;
  const databaseDeletionProtection =
    input.getBoolean("managedDatabaseDeletionProtection") ?? pulumi.getStack() === "main";
  const databaseSkipFinalSnapshot =
    input.getBoolean("managedDatabaseSkipFinalSnapshot") ?? !databaseDeletionProtection;
  const databaseApplyImmediately = input.getBoolean("managedDatabaseApplyImmediately") ?? true;
  const databaseEngineVersion = getNonEmptyConfig(input, "managedDatabaseEngineVersion");

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

  const ingressCidrs = configuredIngressCidrs ?? ["0.0.0.0/0"];

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
    ingress: ingressCidrs.map((cidr) => ({
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
    ...(databaseEngineVersion !== undefined && databaseEngineVersion.length > 0
      ? { engineVersion: databaseEngineVersion }
      : {}),
    instanceClass: databaseInstanceClass,
    allocatedStorage: databaseAllocatedStorage,
    maxAllocatedStorage: databaseMaxAllocatedStorage,
    dbName: databaseName,
    username: databaseUsername,
    password: databasePassword,
    port: 5432,
    dbSubnetGroupName: subnetGroup.name,
    vpcSecurityGroupIds: [securityGroup.id],
    publiclyAccessible: databasePubliclyAccessible,
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

function resolveDatabase(input: pulumi.Config): DatabaseConfig {
  const configuredDatabaseUrl = input.getSecret("databaseUrl");

  if (configuredDatabaseUrl !== undefined) {
    return {
      mode: "manual",
      databaseUrl: configuredDatabaseUrl,
      endpoint: "configured-via-databaseUrl",
    };
  }

  return createManagedAwsDatabase(input);
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

function resolveFrontendImageConfig(input: pulumi.Config): FrontendImageConfig {
  const configuredRepository =
    getNonEmptyConfig(input, "frontendImageRepository") ?? defaultFrontendImageRepository;
  const configuredTag = getNonEmptyConfig(input, "frontendImageTag") ?? "latest";
  const configuredDigest = getNonEmptyConfig(input, "frontendImageDigest");

  const ciRepository = getNonEmptyEnv("CI_FRONTEND_IMAGE_REPOSITORY");
  const ciTag = getNonEmptyEnv("CI_FRONTEND_IMAGE_TAG");
  const ciDigest = getNonEmptyEnv("CI_FRONTEND_IMAGE_DIGEST");

  const resolvedRepository = ciRepository ?? configuredRepository;
  if (/[A-Z]/.test(resolvedRepository)) {
    throw new Error(
      `frontendImageRepository must be lowercase for OCI compatibility, got: ${resolvedRepository}`,
    );
  }

  return {
    repository: resolvedRepository,
    tag: ciTag ?? configuredTag,
    digest: ciDigest ?? configuredDigest,
  };
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

const image = resolveImageConfig(config);
const blobStorage = resolveBlobStorage(config);
const database = resolveDatabase(config);
const frontendEnabled = config.getBoolean("frontendEnabled") ?? false;
const frontendImage = resolveFrontendImageConfig(config);
const frontendIngress = resolveFrontendIngress(config);
const apiIngress = resolveApiIngress(config);
const dns = resolveDns(config);
const configuredOpenaiApiKey = config.getSecret("openaiApiKey") ?? pulumi.secret("");
const resolvedHmacSecret = resolveSecretWithRandom(config, "hmacSecret", "generated-hmac-secret");
const resolvedDatabaseEncryptionKey = resolveSecretWithRandom(
  config,
  "databaseEncryptionKey",
  "generated-database-encryption-key",
);

if (dns.provider === "cloudflare" && apiIngress.mode !== "enabled") {
  throw new Error("dnsProvider=cloudflare requires ingress with apiHostname.");
}

// The namespace is expected to be pre-created by the cluster admin (see
// src/kubernetes/ci-rbac/setup.sh) so the CI ServiceAccount's RBAC can be
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
      replicaCount: {
        api: config.getNumber("apiReplicas") ?? 2,
        worker: config.getNumber("workerReplicas") ?? 2,
      },
      image: {
        repository: image.repository,
        tag: image.tag,
        digest: image.digest ?? "",
      },
      selector: {
        budget: config.get("selectorBudget") ?? "100",
      },
      ...(frontendEnabled
        ? {
            frontend: {
              enabled: true,
              replicaCount: config.getNumber("frontendReplicas") ?? 1,
              image: {
                repository: frontendImage.repository,
                tag: frontendImage.tag,
                digest: frontendImage.digest ?? "",
              },
              ...(frontendIngress.mode === "enabled"
                ? {
                    ingress: {
                      enabled: true,
                      className: frontendIngress.className,
                      host: frontendIngress.host,
                      path: frontendIngress.path,
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
      config: {
        ipRangeCreditCap: config.get("ipRangeCreditCap") ?? "10",
        workerConcurrency: config.get("workerConcurrency") ?? "250",
        databaseEncryptionKeyId: config.get("databaseEncryptionKeyId") ?? "primary",
        blobStorageProvider: blobStorage.provider,
        blobStorageRegion: blobStorage.region,
        blobStorageEndpoint: blobStorage.endpoint ?? "",
        blobStorageBucket: blobStorage.bucket,
        blobStoragePublicUrlPrefix: blobStorage.publicUrlPrefix,
      },
      secrets: {
        databaseUrl: database.databaseUrl,
        openaiApiKey: configuredOpenaiApiKey,
        hmacSecret: resolvedHmacSecret,
        databaseEncryptionKey: resolvedDatabaseEncryptionKey,
        blobStorageAccessKeyId: blobStorage.accessKeyId,
        blobStorageSecretAccessKey: blobStorage.secretAccessKey,
      },
    },
  },
  { dependsOn: [namespace] },
);

if (dns.provider === "cloudflare" && frontendEnabled && frontendIngress.mode === "enabled") {
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

  new cloudflare.DnsRecord("frontend-cloudflare-dns", {
    zoneId: dns.zoneId,
    name: frontendIngress.host,
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

export const frontendServiceName = frontendEnabled
  ? pulumi.output(`${fullname}-frontend`)
  : pulumi.output("");
export const frontendHostname =
  frontendEnabled && frontendIngress.mode === "enabled" ? frontendIngress.host : "";
export const apiServiceName = pulumi.output(`${fullname}-api`);
export const kubernetesNamespace = namespaceName;
export const apiHostname = apiIngress.mode === "enabled" ? apiIngress.host : "";
export const dnsProvider = dns.provider;

export const blobStorageMode = blobStorage.mode;
export const blobStorageBucketName = blobStorage.bucket;
export const blobStoragePublicUrlPrefix = blobStorage.publicUrlPrefix;
export const databaseMode = database.mode;
export const databaseEndpoint = database.endpoint;
