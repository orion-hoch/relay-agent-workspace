import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const certificate = await readFile(
      resolve(process.env.SHOAL_DATA_DIR || '.shoal', 'tls', 'ca.crt'),
      'utf8',
    );
    return new Response(certificate, {
      headers: {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="shoal-ca.crt"',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return Response.json(
      {
        error:
          'Run npm run lan on the host to create this workspace’s local certificate.',
      },
      { status: 404 },
    );
  }
}
