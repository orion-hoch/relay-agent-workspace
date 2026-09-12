// OpenClaw 2026.7.1 HTTP completions can finish before subagent announcements.
// Read native history outside the model loop until the parent has joined results.
export async function readNativeHistory({ baseUrl, token, sessionKey, signal }) {
  const url = `${baseUrl.replace(/\/$/, '')}/sessions/${encodeURIComponent(sessionKey)}/history?limit=1000`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return { messages: [] };
  if (!response.ok) throw new Error(`Native session history failed: HTTP ${response.status}`);
  return response.json();
}

const textOf = message => typeof message.content === 'string' ? message.content
  : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const recordedAt = message => message.__openclaw?.recordTimestampMs ?? message.timestamp ?? 0;
const isFinal = message => message.role === 'assistant' && message.stopReason === 'stop'
  && textOf(message).trim() && !['NO_REPLY', 'No response from OpenClaw.'].includes(textOf(message).trim());

export function acceptedChildren(messages) {
  const children = new Map();
  const calls = new Map(messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'toolCall').map(part => [part.id, part.arguments ?? {}]) : []));
  for (const message of messages) {
    if (message.role !== 'toolResult' || message.toolName !== 'sessions_spawn' || message.isError) continue;
    try {
      const result = JSON.parse(textOf(message));
      if (result.status === 'accepted' && result.childSessionKey && result.runId) {
        const args = calls.get(message.toolCallId) ?? {};
        children.set(result.childSessionKey, { sessionKey: result.childSessionKey, nativeRunId: result.runId, agentId: result.childSessionKey.split(':')[1], task: args.task ?? '', label: args.label, model: result.resolvedModel, provider: result.resolvedProvider, acceptedAt: new Date(recordedAt(message)).toISOString() });
      }
    } catch { /* Other tool output is not a native accepted spawn record. */ }
  }
  return [...children.values()];
}

// Start before the HTTP request so real worker changes are visible during inference.
export function watchNativeDelegation({ baseUrl, token, sessionKey, afterSeq, timeoutMs = 180_000, signal, onChild }) {
  if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error('A pre-request native history sequence is required');
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const deadline = Date.now() + timeoutMs;
  const seen = new Map();
  let httpFinished = false;
  const emit = async (child, status, details = {}) => {
    const value = { ...child, parentSessionKey: sessionKey, status, ...details };
    const signature = JSON.stringify(value);
    if (seen.get(child.sessionKey) === signature) return;
    if (onChild) await onChild({ ...value, observedAt: new Date().toISOString() });
    seen.set(child.sessionKey, signature);
  };
  const read = key => readNativeHistory({ baseUrl, token, sessionKey: key, signal: combinedSignal });
  const task = (async () => {
    while (Date.now() < deadline) {
      combinedSignal.throwIfAborted();
      const snapshot = await read(sessionKey);
      const messages = snapshot.messages.filter(message => (message.__openclaw?.seq ?? 0) > afterSeq);
      const children = acceptedChildren(messages);
      if (httpFinished && !children.length) return null;
      const childSnapshots = await Promise.all(children.map(child => read(child.sessionKey)));
      for (let index = 0; index < children.length; index++) {
        const child = children[index], childMessages = childSnapshots[index].messages;
        if (!seen.has(child.sessionKey)) await emit(child, 'accepted');
        const last = childMessages.filter(message => message.role === 'assistant').at(-1);
        const final = childMessages.filter(isFinal).at(-1);
        const startedAt = childMessages.length ? new Date(recordedAt(childMessages[0])).toISOString() : undefined;
        const usage = childMessages.reduce((sum, message) => {
          if (message.role === 'assistant') { sum.inputTokens += message.usage?.input ?? 0; sum.outputTokens += message.usage?.output ?? 0; }
          return sum;
        }, { inputTokens: 0, outputTokens: 0 });
        if (last && ['error', 'aborted'].includes(last.stopReason)) {
          const error = textOf(last).slice(0, 1000) || 'No completed result.';
          await emit(child, 'failed', { startedAt, completedAt: new Date(recordedAt(last)).toISOString(), error, ...usage });
          throw new Error(`Native worker ${child.sessionKey} ${last.stopReason}: ${error}`);
        }
        if (final) await emit(child, 'completed', { startedAt, completedAt: new Date(recordedAt(final)).toISOString(), result: textOf(final), ...usage });
        else if (startedAt) await emit(child, 'running', { startedAt, ...usage });
      }
      const finals = childSnapshots.map(snapshot => snapshot.messages.filter(isFinal).at(-1));
      const latestChild = children.length && finals.every(Boolean) ? Math.max(...finals.map(recordedAt)) : Infinity;
      const final = messages.filter(message => isFinal(message) && recordedAt(message) >= latestChild).at(-1);
      if (httpFinished && final) {
        const allMessages = [...messages, ...childSnapshots.flatMap(snapshot => snapshot.messages)];
        return {
          content: textOf(final),
          children: children.map((child, index) => ({ ...child, runId: child.nativeRunId, completedAt: recordedAt(finals[index]) })),
          completedAt: recordedAt(final),
          usage: allMessages.reduce((usage, message) => {
            if (message.role === 'assistant') {
              usage.prompt_tokens += message.usage?.input ?? 0;
              usage.completion_tokens += message.usage?.output ?? 0;
            }
            return usage;
          }, { prompt_tokens: 0, completion_tokens: 0 }),
        };
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Native children or their parent synthesis did not complete before the deadline');
  })();
  task.catch(() => {}); // The HTTP caller awaits finish; avoid an early unhandled rejection.
  return { finish: () => { httpFinished = true; return task; }, stop: () => controller.abort() };
}

export function awaitNativeDelegation(options) {
  return watchNativeDelegation(options).finish();
}
