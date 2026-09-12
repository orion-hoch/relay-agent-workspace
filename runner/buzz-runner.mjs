#!/usr/bin/env node
// Local Shoal runner. OpenClaw owns agent/tool execution inside the NemoClaw/OpenShell sandbox.
import { hostname } from 'node:os';
import { startHostTelemetry } from './host-telemetry.mjs';
import { randomUUID } from 'node:crypto';
import { readNativeHistory, watchNativeDelegation } from './shoal-native-results.mjs';
const API = (process.env.BUZZ_API || 'http://127.0.0.1:5173').replace(/\/$/, '');
const TOKEN = process.env.BUZZ_RUNNER_TOKEN || '';
const OPENCLAW = (process.env.BUZZ_OPENCLAW_URL || '').replace(/\/$/, '');
const OPENCLAW_TOKEN = process.env.BUZZ_OPENCLAW_TOKEN || '';
const CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.BUZZ_CONCURRENCY || 2)));
const runnerId = `${hostname()}:${randomUUID()}`;
if (!TOKEN || !OPENCLAW || !OPENCLAW_TOKEN) { console.error('Shoal requires runner credentials and a configured OpenClaw gateway; direct inference fallback is disabled.'); process.exit(1); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...init.headers }, signal: init.signal || AbortSignal.timeout(100000) });
  const data = await res.json().catch(() => null);
  if (!res.ok) { const error = new Error(`${path}: ${res.status} ${data?.error || ''}`); error.status = res.status; throw error; }
  return data;
}
async function execute({ run, packet }) {
  let seq = 0, text = '', pending = '', lastFlush = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Run timed out.')), packet.mode === 'deep' ? 25 * 60000 : 10 * 60000);
  let eventQueue = Promise.resolve();
  const postEvent = async (event) => {
    const payload = JSON.stringify({ ...event, runnerId, attempt: run.attempt, seq: seq + 1 });
    for (let n = 0; ; n++) {
      try { await api(`/api/runs/${run.id}/events`, { method: 'POST', body: payload }); seq++; return; }
      catch (error) { if (n >= 4 || (error.status && error.status < 500)) throw error; await sleep(500 * (n + 1)); }
    }
  };
  const send = event => {
    const posted = eventQueue.then(() => postEvent(event));
    eventQueue = posted.catch(() => {});
    return posted;
  };
  const watchers = new Set();
  const heartbeat = setInterval(() => { api(`/api/runs/${run.id}/events`, { method: 'POST', body: JSON.stringify({ type: 'heartbeat', runnerId, attempt: run.attempt }) }).catch((error) => { if (error.status === 409) controller.abort(error); }); }, 20000);
  const flush = async () => { if (!pending) return; const chunk = pending; await send({ type: 'delta', text: chunk }); pending = ''; lastFlush = Date.now(); };
  let inputTokens = 0, outputTokens = 0;
  try {
    for (let turn = 0; turn < 4; turn++) {
      let terminal = false, finishReason = null, turnText = '', turnInputTokens = 0, turnOutputTokens = 0;
      const nativeSession = `agent:${packet.model.replace('openclaw/', '')}:${packet.sessionKey.toLowerCase()}`;
      const nativeArgs = { baseUrl: OPENCLAW, token: OPENCLAW_TOKEN, sessionKey: nativeSession, signal: controller.signal };
      const before = await readNativeHistory(nativeArgs);
      const afterSeq = Math.max(0, ...before.messages.map((message) => message.__openclaw?.seq ?? 0));
      const watcher = watchNativeDelegation({ ...nativeArgs, afterSeq, timeoutMs: packet.mode === 'deep' ? 20 * 60000 : 8 * 60000, onChild: output => send({ type: 'tool', name: 'native.agent', output: { ...output, nodeId: hostname() } }) });
      watchers.add(watcher);
      const messages = turn === 0 ? packet.messages : [{ role: 'user', content: 'Continue the same Shoal task after the recorded human decision. Inspect the native command completion or resulting artifact. Do not repeat an approved command. If rejected or expired, respect that decision and explain what remains undone. Finish the original task with verified results.' }];
      const response = await fetch(`${OPENCLAW}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENCLAW_TOKEN}`, 'x-openclaw-session-key': packet.sessionKey },
        body: JSON.stringify({ model: packet.model, user: packet.sessionKey, stream: true, messages, max_tokens: packet.outputReserve, stream_options: { include_usage: true } }), signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`OpenClaw ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      const line = async (raw) => {
        if (!raw.startsWith('data:')) return;
        const payload = raw.slice(5).trim(); if (!payload) return;
        if (payload === '[DONE]') { terminal = true; return; }
        let data; try { data = JSON.parse(payload); } catch { throw new Error('Malformed OpenClaw stream event.'); }
        if (data.error) throw new Error(data.error.message || String(data.error));
        if (data.usage) { turnInputTokens += data.usage.prompt_tokens || 0; turnOutputTokens += data.usage.completion_tokens || 0; }
        const choice = data.choices?.[0]; if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta?.content;
        if (typeof delta === 'string') { turnText += delta; text += delta; pending += delta; }
        if (Date.now() - lastFlush > 150) await flush();
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl; while ((nl = buffer.indexOf('\n')) >= 0) { await line(buffer.slice(0, nl).trim()); buffer = buffer.slice(nl + 1); }
      }
      buffer += decoder.decode(); if (buffer.trim()) await line(buffer.trim()); await flush();
      if (!terminal || finishReason !== 'stop') throw new Error(finishReason === 'length' ? 'The response reached its output limit. Partial output was saved; continue in Deep.' : `OpenClaw stream ended without successful completion (${finishReason || 'interrupted'}).`);
      // Native HTTP can end while children are working; join their saved results without extra model polling.
      const delegation = await watcher.finish();
      watchers.delete(watcher);
      if (delegation) {
        text = text.slice(0, text.length - turnText.length) + delegation.content;
        turnText = delegation.content;
        turnInputTokens = delegation.usage.prompt_tokens;
        turnOutputTokens = delegation.usage.completion_tokens;
        await send({ type: 'tool', name: 'sessions_spawn', output: { children: delegation.children, joinedAt: delegation.completedAt } });
      }
      if (!turnText.trim() || ['NO_REPLY', 'No response from OpenClaw.'].includes(turnText.trim())) throw new Error('OpenClaw returned no completed answer.');
      inputTokens += turnInputTokens; outputTokens += turnOutputTokens;
      // The native approval bridge polls every second; allow its last request to reach the journal.
      await sleep(1200);
      let approvals = (await api(`/api/approvals?runId=${run.id}`)).approvals;
      const waiting = approvals.filter((a) => !a.receipt);
      if (!waiting.length) break;
      while (approvals.some((a) => !a.receipt)) {
        if (controller.signal.aborted) throw controller.signal.reason || new Error('Run cancelled.');
        await sleep(1000); approvals = (await api(`/api/approvals?runId=${run.id}`)).approvals;
      }
      if (turn === 3) throw new Error('This task needs another step after approval. Partial progress was saved.');
      text += '\n\n'; pending += '\n\n';
    }
    await send({ type: 'done', result: text, inputTokens: inputTokens || null, outputTokens: outputTokens || null });
    console.log(`[${run.id}] completed via OpenClaw; ${packet.mode}; ${inputTokens} input / ${outputTokens} output tokens`);
  } catch (error) {
    const reason = String(controller.signal.reason?.message || error.message || error);
    console.error(`[${run.id}] ${reason}`);
    await send({ type: 'failed', error: reason, result: text }).catch((postError) => console.error(`[${run.id}] could not persist failure: ${postError.message}`));
  } finally { for (const watcher of watchers) watcher.stop(); clearInterval(heartbeat); clearTimeout(timer); }
}
startHostTelemetry(metrics => api('/api/compute/heartbeat', {
  method: 'POST', signal: AbortSignal.timeout(5000), body: JSON.stringify({ runnerId, metrics }),
}));
let active = 0;
console.log(`Shoal runner ${runnerId}; OpenClaw ${OPENCLAW}; concurrency ${CONCURRENCY}`);
for (;;) {
  if (active < CONCURRENCY) {
    try {
      const claim = await api('/api/runs/claim', { method: 'POST', body: JSON.stringify({ runnerId }) });
      if (claim?.run) { active++; execute(claim).finally(() => active--); continue; }
    } catch (error) { console.error(error.message); await sleep(3000); }
  }
  await sleep(500);
}
