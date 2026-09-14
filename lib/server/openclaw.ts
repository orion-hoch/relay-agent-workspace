// A cancellation is confirmed by the native control plane before Shoal marks it.
export function abortNative(baseUrl: string, token: string, sessionKey: string) {
  return new Promise<unknown>((resolve, reject) => {
    const url = new URL(baseUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    let complete = false;
    const finish = (error?: Error, result?: unknown) => { if (complete) return; complete = true; clearTimeout(timer); socket.close(); if (error) reject(error); else resolve(result); };
    const timer = setTimeout(() => finish(new Error('Native cancellation timed out.')), 10000);
    socket.addEventListener('error', () => finish(new Error('The native control connection failed.')));
    socket.addEventListener('close', () => { if (!complete) finish(new Error('The native control connection closed before cancellation was confirmed.')); });
    socket.addEventListener('message', event => {
      try {
        const frame = JSON.parse(String(event.data));
        if (frame.type === 'event' && frame.event === 'connect.challenge') socket.send(JSON.stringify({ type: 'req', id: 'connect', method: 'connect', params: { minProtocol: 3, maxProtocol: 4, client: { id: 'cli', version: '0.1.0', platform: 'node', mode: 'cli' }, role: 'operator', scopes: ['operator.write'], auth: { token } } }));
        if (frame.type === 'res' && frame.id === 'connect') {
          if (!frame.ok) return finish(new Error('The gateway denied control access. Configure a paired operator token.'));
          const modern = frame.payload?.features?.methods?.includes('sessions.abort');
          socket.send(JSON.stringify({ type: 'req', id: 'abort', method: modern ? 'sessions.abort' : 'chat.abort', params: modern ? { key: sessionKey } : { sessionKey } }));
        }
        if (frame.type === 'res' && frame.id === 'abort') finish(frame.ok ? undefined : new Error('The gateway did not confirm cancellation.'), frame.payload);
      } catch { finish(new Error('Invalid native control response.')); }
    });
  });
}
