import type { NativeEvent } from '../../ledger/src/native.js';
import type { TextMessage, TextUsage } from './types.js';
const check=(v:unknown):void=>{if(!v)throw Error('CODEX_TEXT_EVENT_INVALID');};
const object=(v:unknown):Record<string,unknown>=>{check(v&&typeof v==='object'&&!Array.isArray(v));return v as Record<string,unknown>;};
const string=(v:unknown,max=256):string=>{check(typeof v==='string'&&v.length>0&&Buffer.byteLength(v)<=max);return v as string;};
export function textMessage(v:unknown):TextMessage {
  const i=object(v);check(i.type==='agentMessage');check(typeof i.text==='string'&&Buffer.byteLength(i.text)<=16384);
  return {id:string(i.id),text:i.text as string};
}
export function storedMessages(events:readonly NativeEvent[]):TextMessage[]{
  return events.filter(e=>e.eventKey.startsWith('message:')).map(e=>(JSON.parse(e.payload) as {message:TextMessage}).message);
}
export function boundedMessages(messages:TextMessage[]):TextMessage[]{
  check(messages.length<=32&&new Set(messages.map(m=>m.id)).size===messages.length&&messages.reduce((n,m)=>n+Buffer.byteLength(m.text),0)<=65536);return messages;
}
export function latestUsage(events:readonly NativeEvent[]):TextUsage|null{
  const event=events.filter(e=>e.eventKey.startsWith('usage:')).at(-1);
  return event?(JSON.parse(event.payload) as {usage:TextUsage}).usage:null;
}
export interface TextProjection { key:string; projection:object; turnId:string }
/** Only bounded completed text and token counters are durable. Deltas are not final evidence. */
export function projectTextNotification(frame:Record<string,unknown>,threadId:string|null,turnId:string|null,events:readonly NativeEvent[]):TextProjection|null|undefined{
  const method=frame.method;
  if(typeof method!=='string'||method==='turn/started'||method==='turn/completed')return undefined;
  const p=object(frame.params);
  if(method==='thread/started'){check(object(p.thread).id===threadId);return null;}
  if(method==='warning'||method==='account/rateLimits/updated'){
    if(p.threadId!==undefined)check(p.threadId===threadId);
    if(method==='warning')string(p.message,16384);
    return null; // No diagnostic text, account details or authority is imported.
  }
  check(p.threadId===threadId);
  if(method==='thread/status/changed'){object(p.status);return null;}
  const observedTurn=string(p.turnId);check(turnId===null||observedTurn===turnId);
  if(method==='item/started'||method==='item/completed'){
    const item=object(p.item);check(['userMessage','agentMessage','reasoning'].includes(item.type as string));string(item.id);
    if(item.type!=='agentMessage'||method==='item/started')return null;
    const message=textMessage(item),known=storedMessages(events);
    boundedMessages([...known.filter(m=>m.id!==message.id),message]);
    const terminal=events.find(e=>e.eventKey==='terminal');
    if(terminal){const messages=(JSON.parse(terminal.payload) as {messages:TextMessage[]}).messages;check(messages.some(m=>m.id===message.id&&m.text===message.text));}
    return {key:`message:${message.id}`,projection:{message},turnId:observedTurn};
  }
  if(method==='item/agentMessage/delta'){string(p.itemId);string(p.delta,16384);return null;}
  if(method==='thread/tokenUsage/updated'){
    const total=object(object(p.tokenUsage).total);
    const count=(k:string):number=>{const n=total[k];check(typeof n==='number'&&Number.isSafeInteger(n)&&n>=0&&n<=1_000_000_000);return n as number;};
    const usage:TextUsage={totalTokens:count('totalTokens'),inputTokens:count('inputTokens'),outputTokens:count('outputTokens'),cachedInputTokens:count('cachedInputTokens'),reasoningOutputTokens:count('reasoningOutputTokens')};
    check(usage.totalTokens===usage.inputTokens+usage.outputTokens&&usage.cachedInputTokens<=usage.inputTokens&&usage.reasoningOutputTokens<=usage.outputTokens);
    const old=latestUsage(events);if(old)check(Object.keys(usage).every(k=>usage[k as keyof TextUsage]>=old[k as keyof TextUsage]));
    return {key:`usage:${usage.totalTokens}`,projection:{usage},turnId:observedTurn};
  }
  if(method==='error'){
    check(typeof p.willRetry==='boolean');object(p.error);
    return {key:`provider_error:${events.filter(e=>e.eventKey.startsWith('provider_error:')).length}`,projection:{willRetry:p.willRetry},turnId:observedTurn};
  }
  throw Error('CODEX_TEXT_EVENT_UNSUPPORTED');
}
