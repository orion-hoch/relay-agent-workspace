#!/usr/bin/env node
// Shoal runner: direct model tools run in Docker; OpenClaw owns native tool execution.
import { agentCompletion } from './agent-completion.mjs';
import { streamCompletion } from './completion.mjs';
import { hostname } from 'node:os';
import { startHostTelemetry } from './host-telemetry.mjs';
import { randomUUID } from 'node:crypto';
import { readNativeHistory, watchNativeDelegation } from './shoal-native-results.mjs';
const API = (process.env.BUZZ_API || 'http://127.0.0.1:3000').replace(/\/$/, '');
const TOKEN = process.env.BUZZ_RUNNER_TOKEN || '';
const OPENCLAW = (process.env.BUZZ_OPENCLAW_URL || '').replace(/\/$/, '');
const OPENCLAW_TOKEN = process.env.BUZZ_OPENCLAW_TOKEN || '';
const CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.BUZZ_CONCURRENCY || 2)));
const runnerId = `${hostname()}:${randomUUID()}`;
if (!TOKEN) { console.error('BUZZ_RUNNER_TOKEN is required. Run npm run setup first.'); process.exit(1); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...init.headers }, signal: init.signal || AbortSignal.timeout(100000) });
  const data = await res.json().catch(() => null);
  if (!res.ok) { const error = new Error(`${path}: ${res.status} ${data?.error || ''}`); error.status = res.status; throw error; }
  return data;
}
async function execute({ run, packet, execution }) {
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
  const heartbeat = setInterval(() => { api(`/api/runs/${run.id}/events`, { method: 'POST', body: JSON.stringify({ type: 'heartbeat', runnerId, attempt: run.attempt }) }).catch((error) => { if (error.status === 409) controller.abort(error); }); }, 2000);
  const flush = async () => { if (!pending) return; const chunk = pending; await send({ type: 'delta', text: chunk }); pending = ''; lastFlush = Date.now(); };
  let inputTokens = 0, outputTokens = 0;
  try {
    if (packet.backend === 'vllm') {
      const result = await agentCompletion({ execution, packet, signal: controller.signal, context:input=>api(`/api/runs/${run.id}/context`,{method:'POST',body:JSON.stringify({...input,runnerId,attempt:run.attempt}),signal:controller.signal}), repository:input=>api(`/api/runs/${run.id}/repository`,{method:'POST',body:JSON.stringify({...input,runnerId,attempt:run.attempt}),signal:controller.signal}), collaborate:input=>api(`/api/runs/${run.id}/collaborate`,{method:'POST',body:JSON.stringify({...input,runnerId,attempt:run.attempt}),signal:controller.signal}), onTool: event => send({type:'tool',...event}), onDelta: async chunk => { text += chunk; pending += chunk; if (Date.now() - lastFlush > 150) await flush(); } });
      await flush();
      await send({ type: result.needsInput ? 'input.requested' : result.checkpoint ? 'checkpoint' : 'done', result: result.text, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      console.log(`[${run.id}] completed via ${packet.inferenceModel}; ${result.inputTokens} input / ${result.outputTokens} output tokens`);
      return;
    }
    if (!OPENCLAW || !OPENCLAW_TOKEN) throw new Error('Configure BUZZ_OPENCLAW_URL and BUZZ_OPENCLAW_TOKEN on this runner for agent execution.');
    for (let turn = 0; turn < 4; turn++) {
      const nativeSession = `agent:${packet.model.replace('openclaw/', '')}:${packet.sessionKey.toLowerCase()}`;
      const nativeArgs = { baseUrl: OPENCLAW, token: OPENCLAW_TOKEN, sessionKey: nativeSession, signal: controller.signal };
      const before = await readNativeHistory(nativeArgs);
      const afterSeq = Math.max(0, ...before.messages.map((message) => message.__openclaw?.seq ?? 0));
      const watcher = watchNativeDelegation({ ...nativeArgs, afterSeq, timeoutMs: packet.mode === 'deep' ? 20 * 60000 : 8 * 60000, onChild: output => send({ type: 'tool', name: 'native.agent', output: { ...output, nodeId: hostname() } }) });
      watchers.add(watcher);
      const messages = turn === 0 ? packet.messages : [{ role: 'user', content: 'Continue the same Shoal task after the recorded human decision. Inspect the native command completion or resulting artifact. Do not repeat an approved command. If rejected or expired, respect that decision and explain what remains undone. Finish the original task with verified results.' }];
      const turn_ = await streamCompletion({
        baseUrl: `${OPENCLAW}/v1`, token: OPENCLAW_TOKEN, packet, messages, signal: controller.signal, tools: true,
        headers: { 'x-openclaw-session-key': packet.sessionKey, ...(execution?.runtimeModel ? { 'x-openclaw-model': execution.runtimeModel } : {}) },
        extra: { user: packet.sessionKey },
        onDelta: async delta => { text += delta; pending += delta; if (Date.now() - lastFlush > 150) await flush(); },
      });
      await flush();
      let turnText = turn_.text, turnInputTokens = turn_.inputTokens, turnOutputTokens = turn_.outputTokens;
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
    const reason = String(controller.signal.reason?.message || (error.message==='terminated' ? 'The model server closed its response stream before finishing. Partial progress was saved.' : error.message) || error);
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
      if (claim?.run) { active++; void execute(claim).finally(() => active--); continue; }
    } catch (error) { console.error(error.message); await sleep(3000); }
  }
  await sleep(500);
}
