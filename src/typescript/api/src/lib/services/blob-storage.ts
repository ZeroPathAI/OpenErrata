import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getEnv } from "$lib/config/env.js";

type BlobStorageConfig = {
  endpoint: string | undefined;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrlPrefix: string;
};

class BlobStorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrlPrefix: string;

  constructor(config: BlobStorageConfig) {
    this.client = new S3Client({
      region: "auto",
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      ...(config.endpoint === undefined ? {} : { forcePathStyle: true }),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    this.bucket = config.bucket;
    this.publicUrlPrefix = config.publicUrlPrefix.replace(/\/+$/, "");
  }

  async uploadImage(
    bytes: Uint8Array,
    contentHash: string,
    mimeType: string,
  ): Promise<string> {
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

  getPublicUrl(storageKey: string): string {
    return `${this.publicUrlPrefix}/${storageKey}`;
  }
}

let blobStorageService: BlobStorageService | undefined;

function readBlobStorageConfig(): BlobStorageConfig {
  const env = getEnv();

  return {
    endpoint: env.BLOB_STORAGE_ENDPOINT,
    bucket: env.BLOB_STORAGE_BUCKET,
    accessKeyId: env.BLOB_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.BLOB_STORAGE_SECRET_ACCESS_KEY,
    publicUrlPrefix: env.BLOB_STORAGE_PUBLIC_URL_PREFIX,
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

