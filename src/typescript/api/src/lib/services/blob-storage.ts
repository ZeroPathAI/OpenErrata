import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getEnv } from "$lib/config/env.js";

interface BlobStorageConfigBase {
  provider: "aws" | "s3_compatible";
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

type AwsBlobStorageConfig = BlobStorageConfigBase & {
  provider: "aws";
};

type S3CompatibleBlobStorageConfig = BlobStorageConfigBase & {
  provider: "s3_compatible";
  endpoint: string;
};

type BlobStorageConfig = AwsBlobStorageConfig | S3CompatibleBlobStorageConfig;

class BlobStorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: BlobStorageConfig) {
    this.client =
      config.provider === "aws"
        ? new S3Client({
            region: config.region,
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          })
        : new S3Client({
            region: config.region,
            endpoint: config.endpoint,
            forcePathStyle: true,
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          });
    this.bucket = config.bucket;
  }

  async uploadImage(bytes: Uint8Array, contentHash: string, mimeType: string): Promise<string> {
    const storageKey = `images/${contentHash}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: bytes,
        ContentType: mimeType,
      }),
    );
    return storageKey;
  }
}

let blobStorageService: BlobStorageService | undefined;

function readBlobStorageConfig(): BlobStorageConfig {
  const env = getEnv();

  if (env.BLOB_STORAGE_PROVIDER === "aws") {
    return {
      provider: "aws",
      region: env.BLOB_STORAGE_REGION,
      bucket: env.BLOB_STORAGE_BUCKET,
      accessKeyId: env.BLOB_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.BLOB_STORAGE_SECRET_ACCESS_KEY,
    };
  }

  return {
    provider: "s3_compatible",
    region: env.BLOB_STORAGE_REGION,
    endpoint: env.BLOB_STORAGE_ENDPOINT,
    bucket: env.BLOB_STORAGE_BUCKET,
    accessKeyId: env.BLOB_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.BLOB_STORAGE_SECRET_ACCESS_KEY,
  };
}

function getBlobStorageService(): BlobStorageService {
  blobStorageService ??= new BlobStorageService(readBlobStorageConfig());
  return blobStorageService;
}

export async function uploadImage(
  bytes: Uint8Array,
  contentHash: string,
  mimeType: string,
): Promise<string> {
  return getBlobStorageService().uploadImage(bytes, contentHash, mimeType);
}
