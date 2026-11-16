import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
export interface Store {
  get(key: string): Promise<Uint8Array | null>;
  create(key: string, value: Uint8Array): Promise<boolean>;
  remove(key: string): Promise<void>;
  list(
    prefix: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ keys: string[]; cursor: string }>;
  url(key: string): Promise<string>;
}
export class R2Store implements Store {
  client: S3Client;
  bucket: string;
  prefix: string;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    const required = (...names: string[]) => {
      const value = names.map((n) => env[n]).find(Boolean);
      if (!value) throw Error(`Missing ${names[0]}`);
      return value;
    };
    this.bucket = required("R2_BUCKET");
    this.prefix = env.R2_PREFIX ?? "";
    this.client = new S3Client({
      region: "auto",
      endpoint: required("R2_ENDPOINT", "AWS_ENDPOINT_URL_S3"),
      credentials: {
        accessKeyId: required("R2_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"),
        secretAccessKey: required("R2_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"),
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  async get(key: string) {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }),
      );
      return out.Body ? await out.Body.transformToByteArray() : null;
    } catch (e) {
      if ((e as { $metadata?: { httpStatusCode: number } }).$metadata?.httpStatusCode === 404)
        return null;
      throw e;
    }
  }
  async create(key: string, value: Uint8Array) {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.prefix + key,
          Body: value,
          ContentType: "application/json",
          IfNoneMatch: "*",
        }),
      );
      return true;
    } catch (e) {
      if (
        [409, 412].includes(
          (e as { $metadata?: { httpStatusCode: number } }).$metadata?.httpStatusCode ?? 0,
        )
      )
        return false;
      throw e;
    }
  }
  async remove(key: string) {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }),
    );
  }
  async list(prefix: string, cursor = "", limit = 100) {
    const out = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.prefix + prefix,
        ContinuationToken: cursor || undefined,
        MaxKeys: limit,
      }),
    );
    return {
      keys: (out.Contents ?? []).flatMap((i) => (i.Key ? [i.Key.slice(this.prefix.length)] : [])),
      cursor: out.NextContinuationToken ?? "",
    };
  }
  async url(key: string) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }),
      { expiresIn: 300 },
    );
  }
}
export class MemoryStore implements Store {
  data = new Map<string, Uint8Array>();
  async get(k: string) {
    return this.data.get(k) ?? null;
  }
  async create(k: string, v: Uint8Array) {
    if (this.data.has(k)) return false;
    this.data.set(k, v);
    return true;
  }
  async remove(k: string) {
    this.data.delete(k);
  }
  async list(p: string, c = "", n = 100) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(p) && k > c).sort();
    return { keys: keys.slice(0, n), cursor: keys.length > n ? keys[n - 1] : "" };
  }
  async url(k: string) {
    return "https://r2.invalid/" + encodeURIComponent(k);
  }
}
