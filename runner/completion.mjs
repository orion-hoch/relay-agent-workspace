import { randomUUID } from 'node:crypto';
import { modelFetch } from '../lib/model-fetch.mjs';
import { chatPayload, providerHeaders } from '../lib/cloud-providers.mjs';
import { streamClaude } from './claude-completion.mjs';
// One streaming turn. Native gateways own their tools; direct connections return calls to the sandbox loop.
export async function streamCompletion({ baseUrl, token, packet, signal, onDelta, messages = packet.messages, headers = {}, extra = {}, tools = false, toolDefinitions = [], provider }) {
  if (provider === 'anthropic') return streamClaude({ baseUrl, token, packet, signal, onDelta, messages, toolDefinitions });
  const response = await modelFetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', ...providerHeaders(provider, token), ...headers },
    body: JSON.stringify({ ...chatPayload({ provider, model: packet.model, messages, maxTokens: packet.outputReserve, stream: true, deep: packet.mode === 'deep' }), ...(toolDefinitions.length ? {tools:toolDefinitions} : {}), ...extra }),
  }, provider);
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Model request failed (HTTP ${response.status}). Check the connection and served model.`); }
  let buffer = '', text = '', terminal = false, finish = '', inputTokens = 0, outputTokens = 0;
  const decoder = new TextDecoder(), calls = [];
  const rawDeepSeek = toolDefinitions.length>0 && /deepseek/i.test(packet.model);
  let reasoning = '', emitted=0;
  async function line(value) {
    if (!value.startsWith('data:')) return;
    const payload = value.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') { terminal = true; return; }
    let event; try { event = JSON.parse(payload); } catch { throw new Error('Malformed model stream event.'); }
    if (event.error) throw new Error(event.error.message || 'The model server reported a generation error.');
    const choice = event.choices?.[0];
    if (choice?.finish_reason) finish = choice.finish_reason;
    for (const part of choice?.delta?.tool_calls || []) {
      if (!tools && !toolDefinitions.length) throw new Error('This run has no executable tools granted.');
      if (!Number.isInteger(part.index) || part.index<0 || part.index>15) throw new Error('Invalid model tool call.');
      const call=calls[part.index] ||= {id:'',type:'function',function:{name:'',arguments:''}};
      if(part.id) call.id=part.id;
      if(part.function?.name) call.function.name+=part.function.name;
      if(part.function?.arguments) call.function.arguments+=part.function.arguments;
      if(call.function.arguments.length>32768) throw new Error('Model tool arguments exceed the limit.');
    }
    if(typeof choice?.delta?.reasoning_content==='string') reasoning+=choice.delta.reasoning_content;
    const content = choice?.delta?.content;
    if (typeof content === 'string') {
      text += content;
      const marker=text.indexOf('<｜DSML｜');
      const end=rawDeepSeek ? marker>=0 ? marker : Math.max(0,text.length-20) : text.length;
      if(end>emitted){await onDelta(text.slice(emitted,end));emitted=end;}
    }
    if (event.usage) { inputTokens += event.usage.prompt_tokens || 0; outputTokens += event.usage.completion_tokens || 0; }
  }
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) { await line(buffer.slice(0, newline).trim()); buffer = buffer.slice(newline + 1); }
  }
  buffer += decoder.decode();
  if (buffer.trim()) await line(buffer.trim());
  const toolCalls=calls.filter(Boolean);
  if (!terminal || !(finish === 'stop' || (finish === 'tool_calls' && toolDefinitions.length && toolCalls.length))) throw new Error(finish === 'length' ? 'The response reached its output limit. Partial output was saved; continue in Deep.' : `The model stream was interrupted (${finish || 'no completion'}). Partial output was saved.`);
  // Spark's DeepSeek server emits its native call syntax in content instead of delta.tool_calls.
  if(rawDeepSeek && !toolCalls.length && text.includes('<｜DSML｜')){
    const match=/^([\s\S]*?)<｜DSML｜ calls>([\s\S]*)<\/｜DSML｜ calls>\s*$/.exec(text);
    if(!match || match[1].includes('```'))throw new Error('The model returned an unsupported tool-call format. No command was executed.');
    let remaining=match[2].trim();
    while(remaining) {
      const call=/^<｜DSML｜ invoke name="([a-z_]+)">([\s\S]*?)<\/｜DSML｜ invoke>/.exec(remaining);
      const definition=toolDefinitions.find(tool=>tool.function.name===call?.[1])?.function;
      if(!call || !definition || toolCalls.length>=16)throw new Error('The model returned an unsupported tool-call format. No command was executed.');
      let parameters=call[2].trim();const args={};
      while(parameters) {
        const parameter=/^<｜DSML｜ parameter name="([A-Za-z_][A-Za-z0-9_]*)" string="(true|false)">([\s\S]*?)<\/｜DSML｜ parameter>/.exec(parameters);
        if(!parameter || !Object.hasOwn(definition.parameters.properties,parameter[1]) || Object.hasOwn(args,parameter[1]))throw new Error('The model returned invalid tool parameters.');
        args[parameter[1]]=parameter[2]==='true' ? parameter[3] : JSON.parse(parameter[3]);
        parameters=parameters.slice(parameter[0].length).trim();
      }
      if(definition.parameters.required.some(key=>!Object.hasOwn(args,key)))throw new Error('The model omitted required tool parameters.');
      toolCalls.push({id:'call_'+randomUUID(),type:'function',function:{name:call[1],arguments:JSON.stringify(args)}});
      remaining=remaining.slice(call[0].length).trim();
    }
    if(!toolCalls.length)throw new Error('The model returned an empty tool call.');
    text=match[1].trimEnd();
  }
  if(text.length>emitted)await onDelta(text.slice(emitted));
  if (!tools && !toolCalls.length && !text.trim()) throw new Error('The model returned an empty answer.');
  return { text, inputTokens, outputTokens, toolCalls, assistant:{role:'assistant',content:text || null,...(toolCalls.length?{tool_calls:toolCalls}:{}),...(reasoning?{reasoning_content:reasoning}:{})} };
}
