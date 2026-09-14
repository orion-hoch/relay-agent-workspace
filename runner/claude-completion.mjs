import { modelFetch } from '../lib/model-fetch.mjs';
import { chatPayload, providerHeaders } from '../lib/cloud-providers.mjs';
export async function streamClaude({ baseUrl, token, packet, signal, onDelta, messages, toolDefinitions = [] }) {
  const response = await modelFetch(`${baseUrl}/messages`, { method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', ...providerHeaders('anthropic', token) },
    body: JSON.stringify({...chatPayload({ provider: 'anthropic', model: packet.model, messages, maxTokens: packet.outputReserve, stream: true }),...(toolDefinitions.length ? {tools:toolDefinitions.map(({function:fn})=>({name:fn.name,description:fn.description,input_schema:fn.parameters}))} : {})}) }, 'anthropic');
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Claude request failed (HTTP ${response.status}). Check API access, credits, and model ID.`); }
  let text = '', buffer = '', terminal = false, finish = '', inputTokens = 0, outputTokens = 0;
  const decoder = new TextDecoder(), blocks=[], argumentsByIndex=new Map();
  async function line(value) {
    if (!value.startsWith('data:')) return;
    const event = JSON.parse(value.slice(5).trim());
    if (event.type === 'error') throw new Error('Claude reported a generation error. Partial output was saved.');
    if (event.type === 'message_start') inputTokens = event.message?.usage?.input_tokens || 0;
    if (event.type === 'content_block_start') {
      if(event.content_block?.type==='tool_use' && !toolDefinitions.length) throw new Error('This run has no executable tools granted.');
      blocks[event.index]={...event.content_block};
    }
    if(event.type==='content_block_delta') {
      const block=blocks[event.index];
      if(event.delta?.type==='text_delta') block.text+=event.delta.text;
      if(event.delta?.type==='input_json_delta') {
        const value=(argumentsByIndex.get(event.index)||'')+event.delta.partial_json;
        if(value.length>32768) throw new Error('Model tool arguments exceed the limit.');
        argumentsByIndex.set(event.index,value);
      }
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') { text += event.delta.text; await onDelta(event.delta.text); }
    if (event.type === 'message_delta') { finish = event.delta?.stop_reason || finish; outputTokens = event.usage?.output_tokens || outputTokens; }
    if (event.type === 'message_stop') terminal = true;
  }
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) { await line(buffer.slice(0, newline).trim()); buffer = buffer.slice(newline + 1); }
  }
  buffer += decoder.decode(); if (buffer.trim()) await line(buffer.trim());
  if (!terminal || !['end_turn', 'stop_sequence', ...(toolDefinitions.length?['tool_use']:[])].includes(finish)) throw new Error(finish === 'max_tokens' ? 'Claude reached the output limit. Partial output was saved; continue in Deep.' : 'Claude did not complete its response. Partial output was saved.');
  for(const [index,value] of argumentsByIndex) blocks[index].input=JSON.parse(value);
  const toolCalls=blocks.filter(block=>block.type==='tool_use').map(block=>({id:block.id,type:'function',function:{name:block.name,arguments:JSON.stringify(block.input)}}));
  if (!toolCalls.length && !text.trim()) throw new Error('Claude returned an empty response.');
  return { text, inputTokens, outputTokens, toolCalls, assistant:{role:'assistant',content:blocks} };
}
