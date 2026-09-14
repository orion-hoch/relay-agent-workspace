import { env } from '@/lib/server/env';
import { sessionUser } from '@/lib/server/team';
import { visibleEvents } from '@/lib/server/access';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  let cursor =
    Number(
      request.headers.get('last-event-id') ||
        new URL(request.url).searchParams.get('after'),
    ) || 0;
  let closed = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      try {
        send('retry: 1500\n\n');
        while (!closed && !request.signal.aborted) {
          const user = await sessionUser(request);
          if (!user) {
            send('event: revoked\ndata: {}\n\n');
            break;
          }
          const result = await visibleEvents(env, user, cursor);
          if (result.cursor > cursor || result.reset) {
            cursor = result.cursor;
            send(`id: ${cursor}\ndata: ${JSON.stringify(result)}\n\n`);
          } else send(': keepalive\n\n');
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch {
        /* Disconnects resume from the durable cursor. */
      } finally {
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
