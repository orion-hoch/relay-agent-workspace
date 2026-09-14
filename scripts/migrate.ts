import { env } from '../lib/server/env';
import { ensureSchema } from '../lib/buzz/db';
try { await ensureSchema(env); console.log(`Workspace storage ready (${env.DB.dialect}).`); }
finally { await env.DB.close(); }
