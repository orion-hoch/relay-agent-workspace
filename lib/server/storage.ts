import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

export type Storage = ReturnType<typeof storage>;
export function storage(directory: string) {
  const root = resolve(directory, 'files');
  const bucket = process.env.SHOAL_S3_BUCKET;
  const s3 = bucket ? new S3Client({ region: process.env.AWS_REGION || 'us-east-1', endpoint: process.env.SHOAL_S3_ENDPOINT, forcePathStyle: !!process.env.SHOAL_S3_ENDPOINT }) : null;
  const localPath = (key: string) => {
    const path = resolve(root, key);
    if (!path.startsWith(root + sep)) throw new Error('Invalid storage key.');
    return path;
  };
  return {
    async put(key: string, value: string | ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
      const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
      if (s3) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: options?.httpMetadata?.contentType }));
      else { const path = localPath(key); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { mode: 0o600 }); }
    },
    async get(key: string) {
      try {
        const bytes = s3 ? await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body!.transformToByteArray() : await readFile(localPath(key));
        return { body: new Uint8Array(bytes), text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => new Uint8Array(bytes).buffer };
      } catch (error) {
        const cause = error as { code?: string; name?: string };
        if (cause.code === 'ENOENT' || cause.name === 'NoSuchKey') return null;
        throw error;
      }
    },
    async delete(key: string) {
      if (s3) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      else await unlink(localPath(key)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    },
  };
}
