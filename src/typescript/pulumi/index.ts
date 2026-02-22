import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

const config = new pulumi.Config();
const defaultImageRepository = "ghcr.io/zeropathAI/openerrata-api";
const defaultBlobStorageAccessKeyId = "openerrata";
const chartName = "openerrata";
const releaseName = config.get("releaseName") ?? chartName;
const namespaceName =
  config.get("namespace") ??
  `openerrata-${normalizeDnsCompatibleComponent(pulumi.getStack())}`;
const nameOverride = config.get("nameOverride") ?? undefined;
const fullnameOverride = config.get("fullnameOverride") ?? undefined;

type ImageConfig = {
  repository: string;
  tag: string;
  digest: string | undefined;
};

type BlobStorageConfig = {
  mode: "manual" | "managed_aws";
  endpoint: string;
  bucket: pulumi.Input<string>;
  publicUrlPrefix: pulumi.Input<string>;
  accessKeyId: pulumi.Input<string>;
  secretAccessKey: pulumi.Input<string>;
};

type DatabaseConfig = {
  mode: "manual" | "managed_aws_rds";
  databaseUrl: pulumi.Input<string>;
  endpoint: pulumi.Input<string>;
};

function getNonEmptyEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) {
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
  const configuredRepository = input.get("imageRepository") ?? defaultImageRepository;
  const configuredTag = input.get("imageTag") ?? "latest";
  const configuredDigest = input.get("imageDigest") ?? undefined;

  const ciRepository = getNonEmptyEnv("CI_IMAGE_REPOSITORY");
  const ciTag = getNonEmptyEnv("CI_IMAGE_TAG");
  const ciDigest = getNonEmptyEnv("CI_IMAGE_DIGEST");

  return {
    repository: ciRepository ?? configuredRepository,
    tag: ciTag ?? configuredTag,
    digest: ciDigest ?? configuredDigest,
  };
}

function normalizeDnsCompatibleComponent(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function truncateName(value: string, maxLength: number): string {
  return value.slice(0, maxLength).replace(/-+$/, "");
}

function parseCsvList(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return parsed.length > 0 ? parsed : undefined;
}

function createManagedAwsBlobStorage(input: pulumi.Config): BlobStorageConfig {
  const configuredManagedBucketName = getNonEmptyConfig(
    input,
    "managedBlobStorageBucketName",
  );
  const managedBlobStorageForceDestroy =
    input.getBoolean("managedBlobStorageForceDestroy") ?? false;

  const projectComponent = normalizeDnsCompatibleComponent(pulumi.getProject());
  const stackComponent = normalizeDnsCompatibleComponent(pulumi.getStack());
  const bucketPrefix = truncateName(`${projectComponent}-${stackComponent}`, 44);

  const accountIdentity = aws.getCallerIdentityOutput();
  const derivedBucketName = pulumi.interpolate`${bucketPrefix}-${accountIdentity.accountId}-blobs`;

  const bucket = new aws.s3.BucketV2("blob-storage", {
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

  return {
    mode: "managed_aws",
    endpoint: "",
    bucket: bucket.bucket,
    publicUrlPrefix: pulumi.interpolate`https://${bucket.bucketRegionalDomainName}`,
    accessKeyId: blobWriterAccessKey.id,
    secretAccessKey: blobWriterAccessKey.secret,
  };
}

function resolveBlobStorage(input: pulumi.Config): BlobStorageConfig {
  const configuredBucket = getNonEmptyConfig(input, "blobStorageBucket");
  const configuredPublicUrlPrefix = getNonEmptyConfig(
    input,
    "blobStoragePublicUrlPrefix",
  );
  const configuredSecretAccessKey = input.getSecret("blobStorageSecretAccessKey");

  const hasConfiguredBucket = configuredBucket !== undefined;
  const hasConfiguredPublicUrlPrefix = configuredPublicUrlPrefix !== undefined;
  const hasConfiguredSecretAccessKey = configuredSecretAccessKey !== undefined;
  const manualFieldsProvidedCount = [
    hasConfiguredBucket,
    hasConfiguredPublicUrlPrefix,
    hasConfiguredSecretAccessKey,
  ].filter(Boolean).length;

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
    throw new Error(
      "Manual blob storage configuration was expected but could not be resolved.",
    );
  }

  return {
    mode: "manual",
    endpoint: getNonEmptyConfig(input, "blobStorageEndpoint") ?? "",
    bucket: configuredBucket,
    publicUrlPrefix: configuredPublicUrlPrefix,
    accessKeyId:
      getNonEmptyConfig(input, "blobStorageAccessKeyId") ??
      defaultBlobStorageAccessKeyId,
    secretAccessKey: configuredSecretAccessKey,
  };
}

function createManagedAwsDatabase(input: pulumi.Config): DatabaseConfig {
  const configuredVpcId = getNonEmptyConfig(input, "managedDatabaseVpcId");
  const configuredSubnetIds = parseCsvList(
    getNonEmptyConfig(input, "managedDatabaseSubnetIds"),
  );
  const configuredIngressCidrs = parseCsvList(
    getNonEmptyConfig(input, "managedDatabaseIngressCidrs"),
  );
  const configuredIdentifier = getNonEmptyConfig(input, "managedDatabaseIdentifier");

  const databaseName = getNonEmptyConfig(input, "managedDatabaseName") ?? "openerrata";
  const databaseUsername =
    getNonEmptyConfig(input, "managedDatabaseUsername") ?? "openerrata";
  const databaseInstanceClass =
    getNonEmptyConfig(input, "managedDatabaseInstanceClass") ?? "db.t3.micro";
  const databaseAllocatedStorage =
    input.getNumber("managedDatabaseAllocatedStorage") ?? 20;
  const databaseMaxAllocatedStorage =
    input.getNumber("managedDatabaseMaxAllocatedStorage") ?? 100;
  const databasePubliclyAccessible =
    input.getBoolean("managedDatabasePubliclyAccessible") ?? true;
  const databaseMultiAz = input.getBoolean("managedDatabaseMultiAz") ?? false;
  const databaseBackupRetentionPeriod =
    input.getNumber("managedDatabaseBackupRetentionPeriod") ?? 7;
  const databaseDeletionProtection =
    input.getBoolean("managedDatabaseDeletionProtection") ??
    (pulumi.getStack() === "main");
  const databaseSkipFinalSnapshot =
    input.getBoolean("managedDatabaseSkipFinalSnapshot") ??
    !databaseDeletionProtection;
  const databaseApplyImmediately =
    input.getBoolean("managedDatabaseApplyImmediately") ?? true;
  const databaseEngineVersion = getNonEmptyConfig(
    input,
    "managedDatabaseEngineVersion",
  );

  const projectComponent = normalizeDnsCompatibleComponent(pulumi.getProject());
  const stackComponent = normalizeDnsCompatibleComponent(pulumi.getStack());
  const accountIdentity = aws.getCallerIdentityOutput();
  const identifierPrefix = truncateName(`${projectComponent}-${stackComponent}`, 32);
  const derivedIdentifier = pulumi.interpolate`${identifierPrefix}-${accountIdentity.accountId}-db`;
  const databaseIdentifier = configuredIdentifier ?? derivedIdentifier;

  const vpcId: pulumi.Input<string> =
    configuredVpcId ?? aws.ec2.getVpcOutput({ default: true }).id;

  const subnetIds: pulumi.Input<string[]> =
    configuredSubnetIds ??
    aws.ec2
      .getSubnetsOutput({
        filters: [
          {
            name: "vpc-id",
            values: [vpcId],
          },
        ],
      })
      .ids;

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
    ...(databaseEngineVersion ? { engineVersion: databaseEngineVersion } : {}),
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

const image = resolveImageConfig(config);
const blobStorage = resolveBlobStorage(config);
const database = resolveDatabase(config);
const configuredOpenaiApiKey = config.getSecret("openaiApiKey") ?? pulumi.secret("");
const resolvedHmacSecret = resolveSecretWithRandom(
  config,
  "hmacSecret",
  "generated-hmac-secret",
);
const resolvedDatabaseEncryptionKey = resolveSecretWithRandom(
  config,
  "databaseEncryptionKey",
  "generated-database-encryption-key",
);

const namespace = new k8s.core.v1.Namespace("namespace", {
  metadata: { name: namespaceName },
});

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

new k8s.helm.v3.Chart(releaseName, {
  path: "../../helm/openerrata",
  namespace: namespaceName,
  values: {
    ...(nameOverride ? { nameOverride } : {}),
    ...(fullnameOverride ? { fullnameOverride } : {}),
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
    config: {
      ipRangeCreditCap: config.get("ipRangeCreditCap") ?? "10",
      databaseEncryptionKeyId: config.get("databaseEncryptionKeyId") ?? "primary",
      blobStorageEndpoint: blobStorage.endpoint,
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
}, { dependsOn: [namespace] });

const fullname = resolveHelmFullname({
  releaseName,
  chartName,
  nameOverride,
  fullnameOverride,
});

export const apiServiceName = pulumi.output(`${fullname}-api`);
export const kubernetesNamespace = namespaceName;

export const blobStorageMode = blobStorage.mode;
export const blobStorageBucketName = blobStorage.bucket;
export const blobStoragePublicUrlPrefix = blobStorage.publicUrlPrefix;
export const databaseMode = database.mode;
export const databaseEndpoint = database.endpoint;
