import { NextResponse, type NextRequest } from 'next/server';
import { isAdmin, runnerDevice, runnerPath, sessionUser } from './lib/server/team';

export async function proxy(request: NextRequest): Promise<Response> {
  const path = request.nextUrl.pathname;
  const headers = new Headers(request.headers);
  for (const name of ['x-shoal-user', 'x-shoal-role', 'x-shoal-device'])
    headers.delete(name);
  const origin = request.headers.get('origin');
  try {
    // Cross-site protection applies to state-changing requests only; top-level
    // navigations such as invitation links legitimately arrive cross-site.
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      ((origin && new URL(origin).host !== request.headers.get('host')) ||
        request.headers.get('sec-fetch-site') === 'cross-site')
    )
      return Response.json(
        { error: 'Open this request from your workspace.' },
        { status: 403 },
      );
  } catch {
    return Response.json({ error: 'Invalid origin.' }, { status: 403 });
  }
  if (['/login', '/join', '/api/auth', '/api/lan/certificate', '/api/integrations/google/callback'].includes(path))
    return NextResponse.next({ request: { headers } });
  const runnerRoute =
    runnerPath(path, request.method) ||
    (request.method === 'POST' &&
      ['/api/terminal/claim', '/api/terminal/events'].includes(path));
  if (runnerRoute) {
    const device = await runnerDevice(request);
    if (device) {
      if (device !== 'local' && !path.startsWith('/api/terminal/'))
        return Response.json(
          { error: 'This device is registered for terminal jobs only.' },
          { status: 403 },
        );
      headers.set('x-shoal-device', device);
      return NextResponse.next({ request: { headers } });
    }
  }
  const user = await sessionUser(request);
  if (!user)
    return path.startsWith('/api/')
      ? Response.json(
          { error: 'Sign in to your workspace.' },
          { status: 401, headers: { 'Cache-Control': 'no-store' } },
        )
      : NextResponse.redirect(new URL('/login', request.url));
  if (runnerRoute && !path.startsWith('/api/approvals'))
    return Response.json(
      { error: 'A registered runner is required.' },
      { status: 403 },
    );
  if (!isAdmin(user) && path.startsWith('/api/')) {
    const allowed = [
      '/api/state',
      '/api/workspace',
      '/api/events',
      '/api/stream',
      '/api/messages',
      '/api/conversations',
      '/api/documents',
      '/api/documents/reindex',
      '/api/context',
      '/api/runs',
      '/api/tasks',
      '/api/terminal',
      '/api/team',
      '/api/connections',
      '/api/runtime',
      '/api/search',
      '/api/integrations',
      '/api/integrations/google',
    ];
    const readOnly = ['/api/connections', '/api/runtime'].includes(path);
    if (
      (!allowed.includes(path) &&
        !/^\/api\/(runs\/[^/]+\/cancel|tasks\/[^/]+|approvals\/[^/]+|messages\/[^/]+\/reactions)$/.test(path)) ||
      (readOnly && request.method !== 'GET')
    )
      return Response.json(
        { error: 'Workspace administration requires an admin.' },
        { status: 403 },
      );
    if (
      user.role === 'viewer' &&
      !['GET', 'HEAD'].includes(request.method) &&
      !['/api/team', '/api/context','/api/conversations'].includes(path)
    )
      return Response.json(
        { error: 'Viewers cannot change the workspace or execute tools.' },
        { status: 403 },
      );
  }
  headers.set('x-shoal-user', user.id);
  headers.set('x-shoal-role', user.role);
  return NextResponse.next({ request: { headers } });
}
export const config = { matcher: ['/', '/login', '/join', '/api/:path*'] };
