import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config';
import { CryptoService } from './crypto.service';

/**
 * Object storage for CV files. Files are encrypted by the application before
 * they leave the process, whatever the backend:
 *   local — a mounted volume (single-host Docker)
 *   s3    — MinIO in Docker Compose, or Amazon S3
 *   azure — Azure Blob Storage
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private log = new Logger('Storage');
  private s3?: S3Client;
  private azure?: any;

  constructor(private crypto: CryptoService) {}

  async onModuleInit() {
    const d = config.storage.driver;
    if (d === 's3') {
      const s = config.storage.s3;
      this.s3 = new S3Client({ endpoint: s.endpoint, region: s.region, forcePathStyle: s.forcePathStyle,
        credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey } });
      try { await this.s3.send(new HeadBucketCommand({ Bucket: s.bucket })); }
      catch { await this.s3.send(new CreateBucketCommand({ Bucket: s.bucket })); this.log.log(`Created bucket ${s.bucket}`); }
    } else if (d === 'azure') {
      // Loaded lazily so the dependency is only needed when this driver is chosen.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { BlobServiceClient } = require('@azure/storage-blob');
      const svc = BlobServiceClient.fromConnectionString(config.storage.azure.connectionString);
      this.azure = svc.getContainerClient(config.storage.azure.container);
      await this.azure.createIfNotExists();
    } else {
      await fs.mkdir(config.storage.localDir, { recursive: true });
    }
    this.log.log(`Storage driver: ${d}`);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const enc = this.crypto.encryptBuffer(data);
    if (this.s3) await this.s3.send(new PutObjectCommand({ Bucket: config.storage.s3.bucket, Key: key, Body: enc, ContentType: 'application/octet-stream' }));
    else if (this.azure) await this.azure.getBlockBlobClient(key).uploadData(enc);
    else {
      const p = this.local(key);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, enc);
    }
  }

  async get(key: string): Promise<Buffer> {
    let enc: Buffer;
    if (this.s3) {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: config.storage.s3.bucket, Key: key }));
      enc = Buffer.from(await r.Body!.transformToByteArray());
    } else if (this.azure) enc = await this.azure.getBlockBlobClient(key).downloadToBuffer();
    else enc = await fs.readFile(this.local(key));
    return this.crypto.decryptBuffer(enc);
  }

  async remove(key: string): Promise<void> {
    if (this.s3) await this.s3.send(new DeleteObjectCommand({ Bucket: config.storage.s3.bucket, Key: key }));
    else if (this.azure) await this.azure.getBlockBlobClient(key).deleteIfExists();
    else await fs.rm(this.local(key), { force: true });
  }

  private local(key: string) {
    const safe = key.replace(/\.\./g, '').replace(/^\/+/, '');
    return path.join(config.storage.localDir, safe);
  }
}
