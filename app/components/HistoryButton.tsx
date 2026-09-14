'use client';
import { useEffect, useState } from 'react';
import { buzz, call } from '@/lib/buzz/store';
export function HistoryButton({ room, firstId, beforeLoad }: { room: string; firstId?: string; beforeLoad?: () => (() => void) }) {
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState<{room: string; before?: string; hasMore: boolean; error?: string} | null>(null);
  useEffect(() => {
    let live = true;
    if (room) void (firstId
      ? call<{hasMore: boolean}>(`/api/messages?room=${encodeURIComponent(room)}&before=${encodeURIComponent(firstId)}&check=1`, {method:'GET'})
      : buzz.history(room)).then(page => {
        if (live) setAvailable({room, before:firstId, hasMore:!!firstId && page.hasMore});
      }).catch(error => {if (live) setAvailable({room, before:firstId, hasMore:false, error:error.message});});
    return () => { live = false; };
  }, [room, firstId]);
  async function earlier() {
    setBusy(true); const afterLoad = beforeLoad?.();
    try {
      const page = await buzz.history(room, firstId);
      setAvailable({room, before:page.messages[0]?.id ?? firstId, hasMore:page.hasMore});
      requestAnimationFrame(() => afterLoad?.());
    } catch (error) { setAvailable({room, before:firstId, hasMore:false, error:error instanceof Error ? error.message : 'Could not load history.'}); }
    finally { setBusy(false); }
  }
  const current = available?.room === room && available.before === firstId ? available : null;
  if (!current?.hasMore && !current?.error) return null;
  return <div className="history-control"><button className="btn btn-secondary" disabled={busy} onClick={() => void earlier()}>{busy ? 'Loading history' : current.error ? 'Retry loading history' : 'Load previous messages'}</button>{current.error && <p role="alert">{current.error}</p>}</div>;
}
