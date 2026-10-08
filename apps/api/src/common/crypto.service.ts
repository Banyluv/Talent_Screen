import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { config } from '../config';

/**
 * Application-level encryption (AES-256-GCM) for personal data at rest:
 * CV files, extracted CV text, candidate email and phone.
 * Format for strings: v1:<iv b64>:<tag b64>:<ciphertext b64>
 * Format for buffers: [1 byte version][12 iv][16 tag][ciphertext]
 */
@Injectable()
export class CryptoService {
  private key: Buffer;
  constructor() {
    this.key = Buffer.from(config.dataKey, 'base64');
    if (this.key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  }

  encrypt(text: string | null | undefined): string | null {
    if (text === null || text === undefined || text === '') return null;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
  }
  decrypt(blob: string | null | undefined): string {
    if (!blob) return '';
    const [v, iv, tag, ct] = blob.split(':');
    if (v !== 'v1') throw new Error('Unknown ciphertext version');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  }
  encryptBuffer(buf: Buffer): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(buf), c.final()]);
    return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), ct]);
  }
  decryptBuffer(buf: Buffer): Buffer {
    if (buf[0] !== 1) throw new Error('Unknown file ciphertext version');
    const d = createDecipheriv('aes-256-gcm', this.key, buf.subarray(1, 13));
    d.setAuthTag(buf.subarray(13, 29));
    return Buffer.concat([d.update(buf.subarray(29)), d.final()]);
  }
  sha256(data: string | Buffer) { return createHash('sha256').update(data).digest('hex'); }
  token(bytes = 48) { return randomBytes(bytes).toString('base64url'); }
}
