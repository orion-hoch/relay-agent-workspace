import { resolve } from 'node:path';
import { Database } from './database';
import { storage, type Storage } from './storage';
import type { BuzzEnv } from '../buzz/db';

// Process-wide database and file storage handles for the server, runner, and scripts.
const shared = globalThis as typeof globalThis & { shoalDatabase?: Database; shoalStorage?: Storage };
const directory = () => resolve(process.env.SHOAL_DATA_DIR || '.shoal');
function database() { return shared.shoalDatabase ??= new Database(process.env.DATABASE_URL || '', directory()); }
export const env: BuzzEnv = {
  ...process.env,
  get DB() { return database(); },
  get BUCKET() { return shared.shoalStorage ??= storage(directory()); },
};
