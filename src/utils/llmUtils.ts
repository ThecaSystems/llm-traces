// Ported from public/app/features/explore/TraceView/components/TraceTimelineViewer/SpanDetail/llmUtils.ts
// Extracts LLM span data from OpenInference / OTel GenAI / Vertex AI / generic conventions.

export interface KeyValuePair {
  key: string;
  value: unknown;
}

export interface SpanLog {
  timestamp: number;
  name?: string;
  fields: KeyValuePair[];
}

export interface LlmMessage {
  role: string;
  content: string;
  toolCalls?: LlmToolCall[];
  reasoning?: string[];
  finishReason?: string;
}

export interface LlmToolCall {
  name: string;
  arguments: string;
  id?: string;
}

export interface LlmTokenUsage {
  input?: number;
  output?: number;
  total?: number;
  cacheReadInput?: number;
  cacheWriteInput?: number;
  reasoningOutput?: number;
}

export interface LlmInvocationParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  [key: string]: unknown;
}

export type LlmConvention = 'openinference' | 'otel-genai' | 'vertex' | 'generic' | 'unknown';

export interface LlmSpanData {
  isLlm: boolean;
  convention: LlmConvention;
  spanKind?: string; // openinference.span.kind value: LLM, CHAIN, RETRIEVER, TOOL, EMBEDDING, AGENT
  model: string;
  system?: string;
  inputMessages: LlmMessage[];
  outputMessages: LlmMessage[];
  tokenUsage: LlmTokenUsage;
  invocationParams: LlmInvocationParams;
  finishReason?: string;
  precomputedCostUsd?: number;
}

/**
 * Decodes JSON unicode escape sequences (e.g. \u82f1 → 英) that Python tracing SDKs
 * emit when `ensure_ascii=True` (the default). The escapes are stored as literal
 * 6-character sequences in the span attribute string rather than real Unicode code points.
 */
export function decodeUnicodeEscapes(s: string): string {
  // First handle surrogate pairs: \uD800-\uDBFF followed by \uDC00-\uDFFF
  return s
    .replace(/\\u([dD][89aAbB][0-9a-fA-F]{2})\\u([dD][cCdDeEfF][0-9a-fA-F]{2})/g, (_, hi, lo) => {
      const codePoint = 0x10000 + ((parseInt(hi, 16) - 0xD800) << 10) + (parseInt(lo, 16) - 0xDC00);
      return String.fromCodePoint(codePoint);
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function getAttr(tags: KeyValuePair[], key: string): string | undefined {
  const tag = tags.find((t) => t.key === key);
  if (tag === undefined) return undefined;
  if (tag.value === null || tag.value === undefined) return undefined;
  return decodeUnicodeEscapes(typeof tag.value === 'object' ? JSON.stringify(tag.value) : String(tag.value));
}

function getNumAttr(tags: KeyValuePair[], key: string): number | undefined {
  const tag = tags.find((t) => t.key === key);
  if (tag === undefined) {
    return undefined;
  }
  if (tag.value === null || tag.value === undefined) return undefined;
  if (typeof tag.value === 'string' && tag.value.trim() === '') return undefined;
  const n = Number(tag.value);
  return isNaN(n) ? undefined : n;
}

function looksLikeMessages(value: string): boolean {
  if (!value || value.length < 10) {
    return false;
  }
  return (
    value.includes('"role"') &&
    value.includes('"content"') &&
    (value.startsWith('[') || value.startsWith('{'))
  );
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

// OTel GenAI content follows the versioned role/parts JSON schemas. Span attributes
// are JSON strings until structured span attributes are supported by the SDK/backend.
// https://github.com/open-telemetry/semantic-conventions-genai/tree/e57c543b4889619eb2a05702471937db5119165d/model/gen-ai
function parseStructuredValue(value: unknown): unknown {
  let parsed = value;
  for (let i = 0; i < 2 && typeof parsed === 'string'; i++) {
    try { parsed = JSON.parse(parsed); } catch { break; }
  }
  return parsed;
}

function formatPartValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? '';
}

function extractSemconvMessages(raw: unknown): LlmMessage[] {
  const value = parseStructuredValue(raw);
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((message) => {
    const content: string[] = [];
    const reasoning: string[] = [];
    const toolCalls: LlmToolCall[] = [];
    for (const part of Array.isArray(message.parts) ? message.parts : []) {
      if (!isRecord(part)) continue;
      switch (part.type) {
        case 'text':
          if (typeof part.content === 'string') content.push(part.content);
          break;
        case 'reasoning':
          if (typeof part.content === 'string') reasoning.push(part.content);
          break;
        case 'tool_call':
        case 'server_tool_call':
          toolCalls.push({ name: String(part.name ?? 'unknown'), arguments: formatPartValue(part.arguments ?? part.server_tool_call ?? {}), ...(part.id != null ? { id: String(part.id) } : {}) });
          break;
        case 'tool_call_response':
        case 'server_tool_call_response':
          if (part.response != null || part.server_tool_call_response != null) {
            content.push(formatPartValue(part.response ?? part.server_tool_call_response));
          }
          break;
        case 'blob':
        case 'uri':
        case 'file':
          content.push(`[${String(part.modality ?? part.type)} content]`);
          break;
        case 'compaction':
          if (typeof part.content === 'string') content.push(part.content);
          break;
        // Custom parts remain visible in the raw span attributes; never render
        // unknown inline media as text or accidentally expose base64 payloads.
      }
    }
    return {
      role: String(message.role ?? 'unknown'),
      content: content.join('\n\n'),
      ...(reasoning.length > 0 ? { reasoning } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(typeof message.finish_reason === 'string' ? { finishReason: message.finish_reason } : {}),
    };
  });
}

function extractSemconvInstructions(raw: unknown): LlmMessage[] {
  const value = parseStructuredValue(raw);
  if (!Array.isArray(value)) return [];
  const text = value.filter(isRecord).filter((part) => part.type === 'text' && typeof part.content === 'string')
    .map((part) => String(part.content));
  return text.length > 0 ? [{ role: 'system', content: text.join('\n\n') }] : [];
}

function normalizeToolCalls(raw: unknown): LlmToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  return raw.map((tc: unknown) => {
    if (!isRecord(tc)) {
      return { name: 'unknown', arguments: '' };
    }
    const fnRaw = tc.function;
    const fn = isRecord(fnRaw) ? fnRaw : undefined;
    const name = String((fn && fn.name) || tc.name || 'unknown');
    const rawArgs = (fn && fn.arguments) ?? tc.arguments ?? '';
    const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
    return { name, arguments: args, id: tc.id ? String(tc.id) : undefined };
  });
}

function extractMessagesFromJsonValue(value: string): LlmMessage[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((m) => m && typeof m === 'object' && (m.role || m['message.role']))
        .map((m: Record<string, unknown>) => ({
          role: String(m.role || m['message.role'] || 'unknown'),
          content: String(m.content ?? m['message.content'] ?? m.text ?? ''),
          toolCalls: normalizeToolCalls(m.tool_calls),
        }));
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const messagesField = (parsed as Record<string, unknown>).messages || (parsed as Record<string, unknown>).Messages || (parsed as Record<string, unknown>).prompt;
      if (Array.isArray(messagesField)) {
        return messagesField
          .filter((m: Record<string, unknown>) => m && typeof m === 'object' && (m.role || m['message.role']))
          .map((m: Record<string, unknown>) => ({
            role: String(m.role || m['message.role'] || 'unknown'),
            content: String(m.content ?? m['message.content'] ?? m.text ?? ''),
            toolCalls: normalizeToolCalls(m.tool_calls),
          }));
      }
      if ((parsed as Record<string, unknown>).role) {
        return [{
          role: String((parsed as Record<string, unknown>).role),
          content: String((parsed as Record<string, unknown>).content ?? (parsed as Record<string, unknown>).text ?? ''),
          toolCalls: normalizeToolCalls((parsed as Record<string, unknown>).tool_calls),
        }];
      }
    }
  } catch {
    // not valid JSON
  }
  return [];
}

function extractIndexedMessages(tags: KeyValuePair[], prefix: string): LlmMessage[] {
  const messages: Map<number, LlmMessage> = new Map();
  for (const tag of tags) {
    if (!tag.key.startsWith(prefix)) {
      continue;
    }
    const rest = tag.key.slice(prefix.length);
    const match = rest.match(/^(\d+)\.(.+)$/);
    if (!match) {
      continue;
    }
    const index = parseInt(match[1], 10);
    const field = match[2];
    if (!messages.has(index)) {
      messages.set(index, { role: '', content: '' });
    }
    const msg = messages.get(index)!;
    if (field === 'message.role' || field === 'role') {
      msg.role = String(tag.value);
    } else if (field === 'message.content' || field === 'content') {
      if (typeof tag.value === 'object' && tag.value !== null) {
        try { msg.content = JSON.stringify(tag.value); } catch { msg.content = ''; }
      } else {
        msg.content = decodeUnicodeEscapes(String(tag.value));
      }
    } else if (field === 'message.tool_calls' || field === 'tool_calls') {
      try {
        const raw = typeof tag.value === 'string' ? JSON.parse(tag.value) : tag.value;
        msg.toolCalls = normalizeToolCalls(raw) ?? [];
      } catch {
        // ignore
      }
    }
  }
  return Array.from(messages.entries())
    .sort(([a], [b]) => a - b)
    .map(([, msg]) => {
      if (msg.role === '') {
        msg.role = 'user';
      }
      return msg;
    });
}

function tryExtractMessages(content: string): LlmMessage[] {
  let parsed = extractMessagesFromJsonValue(content);
  if (parsed.length === 0 && content.startsWith('"')) {
    try {
      const inner = JSON.parse(content);
      if (typeof inner === 'string') {
        parsed = extractMessagesFromJsonValue(inner);
      }
    } catch {
      // ignore
    }
  }
  return parsed;
}

function extractMessagesFromEvents(logs: SpanLog[]): { input: LlmMessage[]; output: LlmMessage[] } {
  // Collect system messages separately so they can be prepended (system must come first per LLM API convention)
  const systemMessages: LlmMessage[] = [];
  const nonSystemInput: LlmMessage[] = [];
  // For gen_ai.choice streaming: accumulate by choice index
  const choiceAccumulator: Map<number, { content: string }> = new Map();
  const output: LlmMessage[] = [];
  for (const log of logs) {
    const eventName = log.name || getAttr(log.fields, 'event') || '';
    if (eventName === 'gen_ai.content.prompt' || eventName === 'gen_ai.user.message') {
      const content = getAttr(log.fields, 'gen_ai.prompt') || getAttr(log.fields, 'gen_ai.content') || '';
      const role = getAttr(log.fields, 'role') || 'user';
      const parsed = tryExtractMessages(content);
      if (parsed.length > 0) {
        nonSystemInput.push(...parsed);
      } else if (content) {
        nonSystemInput.push({ role, content });
      }
    } else if (eventName === 'gen_ai.system.message') {
      const content = getAttr(log.fields, 'gen_ai.content') || getAttr(log.fields, 'gen_ai.prompt') || '';
      if (content) {
        systemMessages.push({ role: 'system', content });
      }
    } else if (eventName === 'gen_ai.content.completion' || eventName === 'gen_ai.assistant.message') {
      const content = getAttr(log.fields, 'gen_ai.completion') || getAttr(log.fields, 'gen_ai.content') || '';
      const parsed = tryExtractMessages(content);
      if (parsed.length > 0) {
        output.push(...parsed);
      } else if (content) {
        output.push({ role: 'assistant', content });
      }
    } else if (eventName === 'gen_ai.choice') {
      const content = getAttr(log.fields, 'gen_ai.completion') || getAttr(log.fields, 'gen_ai.content') || '';
      const choiceIndexRaw = getAttr(log.fields, 'gen_ai.choice.index');
      const choiceIndex = choiceIndexRaw !== undefined ? parseInt(choiceIndexRaw, 10) : 0;
      const existing = choiceAccumulator.get(choiceIndex);
      if (existing) {
        existing.content += content;
      } else {
        choiceAccumulator.set(choiceIndex, { content });
      }
    }
  }
  // Flush accumulated choice chunks as output messages
  if (choiceAccumulator.size > 0) {
    for (const [, chunk] of Array.from(choiceAccumulator.entries()).sort(([a], [b]) => a - b)) {
      const parsed = tryExtractMessages(chunk.content);
      if (parsed.length > 0) {
        output.push(...parsed);
      } else if (chunk.content) {
        output.push({ role: 'assistant', content: chunk.content });
      }
    }
  }
  // System messages always appear first in the conversation
  return { input: [...systemMessages, ...nonSystemInput], output };
}

function extractGcpVertexRequestMessages(jsonBlob: string): LlmMessage[] {
  // Gemini API request format: { contents: [{role, parts: [{text}]}], system_instruction?: {parts: [{text}]} }
  try {
    const parsed = JSON.parse(jsonBlob);
    if (!isRecord(parsed)) {
      return [];
    }
    const messages: LlmMessage[] = [];
    const sysInstr = parsed.system_instruction;
    if (isRecord(sysInstr) && Array.isArray(sysInstr.parts)) {
      const text = (sysInstr.parts as unknown[])
        .map((p) => (isRecord(p) ? String(p.text ?? '') : ''))
        .join('');
      if (text) {
        messages.push({ role: 'system', content: text });
      }
    }
    if (Array.isArray(parsed.contents)) {
      for (const item of parsed.contents as unknown[]) {
        if (!isRecord(item)) {
          continue;
        }
        const role = String(item.role ?? 'user');
        const parts = item.parts;
        const text = Array.isArray(parts)
          ? (parts as unknown[]).map((p) => {
              if (!isRecord(p)) return '';
              if (p.text !== undefined) return String(p.text);
              if (p.functionCall !== undefined) return `[Function call: ${JSON.stringify(p.functionCall)}]`;
              if (p.functionResponse !== undefined) return `[Function response: ${JSON.stringify(p.functionResponse)}]`;
              return '';
            }).filter(Boolean).join('\n')
          : '';
        messages.push({ role, content: text });
      }
    }
    return messages;
  } catch {
    return [];
  }
}

function extractGcpVertexResponseMessages(jsonBlob: string): LlmMessage[] {
  // Gemini API response format: { candidates: [{content: {role, parts: [{text}]}}] }
  try {
    const parsed = JSON.parse(jsonBlob);
    if (!isRecord(parsed) || !Array.isArray(parsed.candidates)) {
      return [];
    }
    return (parsed.candidates as unknown[]).map((c) => {
      if (!isRecord(c) || !isRecord(c.content)) {
        return { role: 'model', content: '' };
      }
      const role = String(c.content.role ?? 'model');
      const parts = c.content.parts;
      const text = Array.isArray(parts)
        ? (parts as unknown[]).map((p) => {
            if (!isRecord(p)) return '';
            if (p.text !== undefined) return String(p.text);
            if (p.functionCall !== undefined) return `[Function call: ${JSON.stringify(p.functionCall)}]`;
            if (p.functionResponse !== undefined) return `[Function response: ${JSON.stringify(p.functionResponse)}]`;
            return '';
          }).filter(Boolean).join('\n')
        : '';
      return { role, content: text };
    });
  } catch {
    return [];
  }
}

function detectConvention(tags: KeyValuePair[]): LlmConvention | null {
  const oiKind = getAttr(tags, 'openinference.span.kind');
  if (oiKind) {
    return 'openinference';
  }
  const genAiSystem = getAttr(tags, 'gen_ai.system');
  if (genAiSystem && (genAiSystem.includes('vertex') || genAiSystem.includes('gcp'))) {
    return 'vertex';
  }
  // OTel operation/provider are authoritative even on mixed-format spans.
  // An explicit OpenInference span kind above still takes precedence.
  if (getAttr(tags, 'gen_ai.operation.name') || getAttr(tags, 'gen_ai.provider.name')) {
    return 'otel-genai';
  }
  // Only classify as openinference when gen_ai.system is absent — if it's present the span
  // follows OTel GenAI convention even if it also carries llm.request.type (Traceloop compat).
  if (!genAiSystem && tags.some((t) => t.key === 'llm.model_name' || t.key === 'llm.request.type' || t.key.startsWith('llm.input_messages.') || t.key.startsWith('llm.output_messages.'))) {
    return 'openinference';
  }
  if (tags.some((t) => t.key.startsWith('llm.prompts.') || t.key.startsWith('llm.completions.'))) {
    return 'vertex';
  }
  if (tags.some((t) => t.key.startsWith('gcp.vertex.agent.'))) {
    return 'vertex';
  }
  if (genAiSystem || tags.some((t) => t.key.startsWith('gen_ai.'))) {
    return 'otel-genai';
  }
  const hasCompletionType = tags.some(
    (t) => (t.key.endsWith('.operation.type') || t.key === 'operation.type') && String(t.value).toLowerCase().includes('completion')
  );
  const hasMessageAttr = tags.some((t) => typeof t.value === 'string' && looksLikeMessages(t.value));
  if (hasCompletionType || hasMessageAttr) {
    return 'generic';
  }
  return null;
}

function extractOpenInference(tags: KeyValuePair[], logs: SpanLog[]): Omit<LlmSpanData, 'isLlm'> {
  const model = getAttr(tags, 'gen_ai.response.model') || getAttr(tags, 'llm.model_name') || getAttr(tags, 'gen_ai.request.model') || 'unknown';
  const spanKind = getAttr(tags, 'openinference.span.kind');
  let inputMessages = extractIndexedMessages(tags, 'llm.input_messages.');
  if (inputMessages.length === 0) {
    inputMessages = extractIndexedMessages(tags, 'llm.prompts.');
  }
  if (inputMessages.length === 0) {
    const genAiInput = getAttr(tags, 'gen_ai.input_messages');
    if (genAiInput) {
      inputMessages = extractMessagesFromJsonValue(genAiInput);
    }
  }
  if (inputMessages.length === 0) {
    const gcpReq = getAttr(tags, 'gcp.vertex.agent.llm_request');
    if (gcpReq) {
      inputMessages = extractGcpVertexRequestMessages(gcpReq);
    }
  }
  let outputMessages = extractIndexedMessages(tags, 'llm.output_messages.');
  if (outputMessages.length === 0) {
    outputMessages = extractIndexedMessages(tags, 'llm.completions.');
  }
  if (outputMessages.length === 0) {
    const genAiOutput = getAttr(tags, 'gen_ai.output_messages');
    if (genAiOutput) {
      outputMessages = extractMessagesFromJsonValue(genAiOutput);
    }
  }
  if (outputMessages.length === 0) {
    const gcpResp = getAttr(tags, 'gcp.vertex.agent.llm_response');
    if (gcpResp) {
      outputMessages = extractGcpVertexResponseMessages(gcpResp);
    }
  }
  if (inputMessages.length === 0) {
    const inputValue = getAttr(tags, 'input.value');
    if (inputValue) {
      inputMessages = extractMessagesFromJsonValue(inputValue);
      if (inputMessages.length === 0 && inputValue.trim()) {
        inputMessages = [{ role: 'user', content: inputValue }];
      }
    }
  }
  if (outputMessages.length === 0) {
    const outputValue = getAttr(tags, 'output.value');
    if (outputValue) {
      outputMessages = extractMessagesFromJsonValue(outputValue);
      if (outputMessages.length === 0 && outputValue.trim()) {
        outputMessages = [{ role: 'assistant', content: outputValue }];
      }
    }
  }
  if (inputMessages.length === 0 && outputMessages.length === 0 && logs.length > 0) {
    const fromEvents = extractMessagesFromEvents(logs);
    inputMessages = fromEvents.input;
    outputMessages = fromEvents.output;
  }
  let invocationParams: LlmInvocationParams = {};
  const invParamsStr = getAttr(tags, 'llm.invocation_parameters');
  if (invParamsStr) {
    let parsed = false;
    try {
      invocationParams = JSON.parse(invParamsStr);
      parsed = true;
    } catch {
      // try Python repr format: single quotes, True/False/None
    }
    if (!parsed) {
      try {
        const normalized = invParamsStr
          .replace(/'/g, '"')
          .replace(/\bTrue\b/g, 'true')
          .replace(/\bFalse\b/g, 'false')
          .replace(/\bNone\b/g, 'null');
        invocationParams = JSON.parse(normalized);
        parsed = true;
      } catch {
        // fall through to individual gen_ai.request.* attributes
      }
    }
    if (!parsed) {
      const temp = getNumAttr(tags, 'gen_ai.request.temperature');
      const maxTok = getNumAttr(tags, 'gen_ai.request.max_tokens');
      const topP = getNumAttr(tags, 'gen_ai.request.top_p');
      if (temp !== undefined) invocationParams.temperature = temp;
      if (maxTok !== undefined) invocationParams.maxTokens = maxTok;
      if (topP !== undefined) invocationParams.topP = topP;
    }
  }
  const finishReason = getAttr(tags, 'llm.output_messages.0.message.finish_reason')
    ?? getAttr(tags, 'output.finish_reason')
    ?? getAttr(tags, 'llm.stop_reason');
  const precomputedCostUsd = getNumAttr(tags, 'gen_ai.cost.total_cost');
  return {
    convention: 'openinference',
    spanKind,
    model,
    system: getAttr(tags, 'gen_ai.system') || getAttr(tags, 'llm.system'),
    inputMessages,
    outputMessages,
    tokenUsage: {
      input: getNumAttr(tags, 'llm.token_count.prompt') ?? getNumAttr(tags, 'gen_ai.usage.input_tokens') ?? getNumAttr(tags, 'llm.usage.prompt_tokens'),
      output: getNumAttr(tags, 'llm.token_count.completion') ?? getNumAttr(tags, 'gen_ai.usage.output_tokens') ?? getNumAttr(tags, 'llm.usage.completion_tokens'),
      total: getNumAttr(tags, 'llm.token_count.total') ?? getNumAttr(tags, 'gen_ai.usage.total_tokens') ?? getNumAttr(tags, 'llm.usage.total_tokens'),
    },
    invocationParams,
    finishReason,
    ...(precomputedCostUsd !== undefined ? { precomputedCostUsd } : {}),
  };
}

function extractOtelGenAi(tags: KeyValuePair[], logs: SpanLog[]): Omit<LlmSpanData, 'isLlm'> {
  // Prefer gen_ai.response.model when present — after streaming/routing the served model may differ
  // from the requested model (e.g. provider-side aliasing or fallback routing).
  const model = getAttr(tags, 'gen_ai.response.model') || getAttr(tags, 'gen_ai.request.model') || getAttr(tags, 'llm.request.model') || 'unknown';
  const fromEvents = extractMessagesFromEvents(logs);
  const inputMessages = extractSemconvMessages(tags.find((t) => t.key === 'gen_ai.input.messages')?.value);
  const outputMessages = extractSemconvMessages(tags.find((t) => t.key === 'gen_ai.output.messages')?.value);
  // Current span attributes take precedence over legacy span events and
  // compatibility projections. Instructions are separate from chat history.
  const instructions = extractSemconvInstructions(tags.find((t) => t.key === 'gen_ai.system_instructions')?.value);
  if (inputMessages.length === 0) inputMessages.push(...fromEvents.input);
  if (outputMessages.length === 0) outputMessages.push(...fromEvents.output);
  if (inputMessages.length === 0) {
    const prompt = getAttr(tags, 'gen_ai.prompt');
    if (prompt) {
      const parsed = extractMessagesFromJsonValue(prompt);
      inputMessages.push(...(parsed.length > 0 ? parsed : [{ role: 'user', content: prompt }]));
    }
  }
  if (inputMessages.length === 0) {
    const genAiInput = getAttr(tags, 'gen_ai.input_messages');
    if (genAiInput) {
      inputMessages.push(...extractMessagesFromJsonValue(genAiInput));
    }
  }
  if (inputMessages.length === 0) {
    // Traceloop flat-indexed format: gen_ai.prompt.{i}.role / gen_ai.prompt.{i}.content
    inputMessages.push(...extractIndexedMessages(tags, 'gen_ai.prompt.'));
  }
  if (outputMessages.length === 0) {
    const completion = getAttr(tags, 'gen_ai.completion');
    if (completion) {
      const parsed = extractMessagesFromJsonValue(completion);
      outputMessages.push(...(parsed.length > 0 ? parsed : [{ role: 'assistant', content: completion }]));
    }
  }
  if (outputMessages.length === 0) {
    const genAiOutput = getAttr(tags, 'gen_ai.output_messages');
    if (genAiOutput) {
      outputMessages.push(...extractMessagesFromJsonValue(genAiOutput));
    }
  }
  if (outputMessages.length === 0) {
    // Traceloop flat-indexed format: gen_ai.completion.{i}.role / gen_ai.completion.{i}.content
    outputMessages.push(...extractIndexedMessages(tags, 'gen_ai.completion.'));
  }
  if (instructions.length > 0) inputMessages.unshift(...instructions);
  const finishReasons = parseStructuredValue(tags.find((t) => t.key === 'gen_ai.response.finish_reasons')?.value);
  if (Array.isArray(finishReasons)) {
    outputMessages.forEach((message, index) => {
      if (finishReasons[index] != null) message.finishReason = String(finishReasons[index]);
    });
  }
  const finishReason = outputMessages[0]?.finishReason
    ?? (Array.isArray(finishReasons) && finishReasons.length > 0 ? String(finishReasons[0]) : undefined)
    ?? getAttr(tags, 'gen_ai.response.finish_reasons.0')
    ?? getAttr(tags, 'gen_ai.finish_reason');
  const precomputedCostUsd = getNumAttr(tags, 'gen_ai.cost.total_cost');
  const inputTokens = getNumAttr(tags, 'gen_ai.usage.input_tokens') ?? getNumAttr(tags, 'gen_ai.usage.prompt_tokens');
  const outputTokens = getNumAttr(tags, 'gen_ai.usage.output_tokens') ?? getNumAttr(tags, 'gen_ai.usage.completion_tokens');
  return {
    convention: 'otel-genai',
    model,
    system: getAttr(tags, 'gen_ai.provider.name') ?? getAttr(tags, 'gen_ai.system'),
    inputMessages,
    outputMessages,
    tokenUsage: {
      input: inputTokens,
      output: outputTokens,
      total: getNumAttr(tags, 'gen_ai.usage.total_tokens') ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined),
      cacheReadInput: getNumAttr(tags, 'gen_ai.usage.cache_read.input_tokens'),
      cacheWriteInput: getNumAttr(tags, 'gen_ai.usage.cache_write.input_tokens'),
      reasoningOutput: getNumAttr(tags, 'gen_ai.usage.reasoning.output_tokens'),
    },
    invocationParams: {
      temperature: getNumAttr(tags, 'gen_ai.request.temperature'),
      maxTokens: getNumAttr(tags, 'gen_ai.request.max_tokens'),
      topP: getNumAttr(tags, 'gen_ai.request.top_p'),
      ...(getAttr(tags, 'gen_ai.request.reasoning.level') ? { reasoningLevel: getAttr(tags, 'gen_ai.request.reasoning.level') } : {}),
      ...(getAttr(tags, 'gen_ai.request.stream') !== undefined ? { stream: getAttr(tags, 'gen_ai.request.stream') === 'true' } : {}),
      ...(getNumAttr(tags, 'gen_ai.request.seed') !== undefined ? { seed: getNumAttr(tags, 'gen_ai.request.seed') } : {}),
      ...(getNumAttr(tags, 'gen_ai.request.choice.count') !== undefined ? { choiceCount: getNumAttr(tags, 'gen_ai.request.choice.count') } : {}),
      ...(getAttr(tags, 'gen_ai.output.type') ? { outputType: getAttr(tags, 'gen_ai.output.type') } : {}),
      // gen_ai.request.top_k is used by Anthropic, Gemini and other providers.
      // It must be included explicitly here because the LlmInvocationParams index type
      // only passes through named fields; unknown keys from tags are not auto-collected.
      ...(getNumAttr(tags, 'gen_ai.request.top_k') !== undefined
        ? { topK: getNumAttr(tags, 'gen_ai.request.top_k') }
        : {}),
      ...(getNumAttr(tags, 'gen_ai.request.frequency_penalty') !== undefined
        ? { frequencyPenalty: getNumAttr(tags, 'gen_ai.request.frequency_penalty') }
        : {}),
      ...(getNumAttr(tags, 'gen_ai.request.presence_penalty') !== undefined
        ? { presencePenalty: getNumAttr(tags, 'gen_ai.request.presence_penalty') }
        : {}),
      ...(getAttr(tags, 'gen_ai.operation.name') !== undefined
        ? { operationName: getAttr(tags, 'gen_ai.operation.name') }
        : {}),
    },
    finishReason,
    ...(precomputedCostUsd !== undefined ? { precomputedCostUsd } : {}),
  };
}

function extractGeneric(tags: KeyValuePair[], logs: SpanLog[], operationName?: string): Omit<LlmSpanData, 'isLlm'> {
  let inputMessages: LlmMessage[] = [];
  let outputMessages: LlmMessage[] = [];
  const inputKeys = ['workflow.input', 'input.value', 'input', 'request.body', 'llm.input', 'prompt'];
  const outputKeys = ['workflow.output', 'output.value', 'output', 'response.body', 'llm.output', 'completion'];
  for (const key of inputKeys) {
    const val = getAttr(tags, key);
    if (val && looksLikeMessages(val)) {
      inputMessages = extractMessagesFromJsonValue(val);
      if (inputMessages.length > 0) {
        break;
      }
    }
  }
  for (const key of outputKeys) {
    const val = getAttr(tags, key);
    if (val && looksLikeMessages(val)) {
      outputMessages = extractMessagesFromJsonValue(val);
      if (outputMessages.length > 0) {
        break;
      }
    }
  }
  const model =
    getAttr(tags, 'gen_ai.request.model') || getAttr(tags, 'llm.model_name') || getAttr(tags, 'model') || operationName || 'unknown';
  if (inputMessages.length === 0 && outputMessages.length === 0 && logs.length > 0) {
    const fromEvents = extractMessagesFromEvents(logs);
    inputMessages = fromEvents.input;
    outputMessages = fromEvents.output;
  }
  const finishReason = getAttr(tags, 'finish_reason') ?? getAttr(tags, 'stop_reason');
  const precomputedCostUsd = getNumAttr(tags, 'gen_ai.cost.total_cost');
  return {
    convention: 'generic',
    model,
    inputMessages,
    outputMessages,
    tokenUsage: {
      input: getNumAttr(tags, 'gen_ai.usage.input_tokens') ?? getNumAttr(tags, 'llm.token_count.prompt') ?? getNumAttr(tags, 'prompt_tokens'),
      output: getNumAttr(tags, 'gen_ai.usage.output_tokens') ?? getNumAttr(tags, 'llm.token_count.completion') ?? getNumAttr(tags, 'completion_tokens'),
      total: getNumAttr(tags, 'gen_ai.usage.total_tokens') ?? getNumAttr(tags, 'llm.token_count.total') ?? getNumAttr(tags, 'total_tokens'),
    },
    invocationParams: {
      temperature: getNumAttr(tags, 'gen_ai.request.temperature') ?? getNumAttr(tags, 'temperature'),
      maxTokens: getNumAttr(tags, 'gen_ai.request.max_tokens') ?? getNumAttr(tags, 'max_tokens'),
      topP: getNumAttr(tags, 'gen_ai.request.top_p') ?? getNumAttr(tags, 'top_p'),
    },
    finishReason,
    ...(precomputedCostUsd !== undefined ? { precomputedCostUsd } : {}),
  };
}

export function extractLlmSpanData(tags: KeyValuePair[], logs: SpanLog[], operationName?: string): LlmSpanData {
  const convention = detectConvention(tags);
  if (!convention) {
    return { isLlm: false, convention: 'unknown', model: '', inputMessages: [], outputMessages: [], tokenUsage: {}, invocationParams: {}, finishReason: undefined };
  }
  let data: Omit<LlmSpanData, 'isLlm'>;
  switch (convention) {
    case 'openinference':
      data = extractOpenInference(tags, logs);
      break;
    case 'otel-genai':
      data = extractOtelGenAi(tags, logs);
      break;
    case 'vertex':
      data = { ...extractOpenInference(tags, logs), convention: 'vertex' };
      break;
    default:
      data = extractGeneric(tags, logs, operationName);
  }
  // For OpenInference, only treat the span as LLM if it's an LLM call or a GUARDRAIL
  // (guardrails invoke an LLM internally and carry the same llm.* attributes).
  // CHAIN, TOOL, RETRIEVER etc. are structural spans, not the model call itself.
  const isLlm = convention === 'openinference'
    ? data.spanKind?.toUpperCase() === 'LLM' || data.spanKind?.toUpperCase() === 'GUARDRAIL'
    : convention === 'otel-genai' && getAttr(tags, 'gen_ai.operation.name')
      ? INFERENCE_OPERATIONS.has(getAttr(tags, 'gen_ai.operation.name')!.toLowerCase())
      : true;
  return { isLlm, ...data };
}

export function isAiSpan(tags: KeyValuePair[]): boolean {
  return detectConvention(tags) !== null;
}

export function isOpenInferenceSpan(tags: KeyValuePair[]): boolean {
  return tags.some((t) => t.key === 'openinference.span.kind');
}

export function isEmbeddingSpan(tags: KeyValuePair[]): boolean {
  const requestType = tags.find((t) => t.key === 'llm.request.type');
  if (requestType && String(requestType.value).toLowerCase().includes('embedding')) {
    return true;
  }
  const opName = tags.find((t) => t.key === 'gen_ai.operation.name');
  if (opName) {
    const v = String(opName.value).toLowerCase();
    if (v === 'embeddings' || v === 'create_embeddings' || v === 'embed') {
      return true;
    }
  }
  return false;
}

export function isLlmSpan(tags: KeyValuePair[]): boolean {
  // Embedding spans are not LLM chat/completion spans
  if (isEmbeddingSpan(tags)) {
    return false;
  }
  const oiKind = tags.find((t) => t.key === 'openinference.span.kind');
  if (oiKind) {
    const kind = String(oiKind.value).toUpperCase();
    return kind === 'LLM' || kind === 'GUARDRAIL';
  }
  const operation = getAttr(tags, 'gen_ai.operation.name');
  if (operation) return INFERENCE_OPERATIONS.has(operation.toLowerCase());
  if (tags.some(
    (t) =>
      t.key === 'gen_ai.system' ||
      t.key === 'gen_ai.request.model' ||
      t.key === 'llm.model_name' ||
      t.key === 'llm.request.type' ||
      t.key.startsWith('llm.input_messages.') ||
      t.key.startsWith('llm.prompts.') ||
      t.key.startsWith('gen_ai.usage.') ||
      t.key.startsWith('gcp.vertex.agent.')
  )) {
    return true;
  }
  // Generic convention: operation.type containing "completion"
  return tags.some(
    (t) => (t.key.endsWith('.operation.type') || t.key === 'operation.type') && String(t.value).toLowerCase().includes('completion')
  );
}

export function isGuardrailSpan(tags: KeyValuePair[]): boolean {
  const oiKind = tags.find((t) => t.key === 'openinference.span.kind');
  if (oiKind && String(oiKind.value).toUpperCase() === 'GUARDRAIL') {
    return true;
  }
  const opName = tags.find((t) => t.key === 'gen_ai.operation.name');
  if (opName) {
    const v = String(opName.value).toLowerCase();
    if (v === 'guardrail' || v === 'check_guardrail') { return true; }
  }
  return false;
}

// Only inference operations count as model calls; tool, agent, memory and
// retrieval operations are AI spans, but not LLM spans or token-bearing calls.
const INFERENCE_OPERATIONS = new Set(['chat', 'text_completion', 'generate_content', 'completions', 'generate']);

// Maps gen_ai.operation.name values (OTel GenAI spec) to normalized span kind labels.
const OTEL_OPERATION_TO_KIND: Record<string, string> = {
  // LLM
  chat: 'LLM',
  text_completion: 'LLM',
  generate_content: 'LLM',
  fetch_response: 'RESPONSE',
  completions: 'LLM',
  generate: 'LLM',
  // AGENT
  invoke_agent: 'AGENT',
  execute_agent: 'AGENT',
  create_agent: 'AGENT',
  invoke_workflow: 'WORKFLOW',
  plan: 'PLAN',
  retrieval: 'RETRIEVER',
  create_memory: 'MEMORY',
  update_memory: 'MEMORY',
  upsert_memory: 'MEMORY',
  delete_memory: 'MEMORY',
  search_memory: 'MEMORY',
  create_memory_store: 'MEMORY',
  delete_memory_store: 'MEMORY',
  // TOOL
  execute_tool: 'TOOL',
  tool_call: 'TOOL',
  // EMBEDDING
  embeddings: 'EMBEDDING',
  create_embeddings: 'EMBEDDING',
  embed: 'EMBEDDING',
  // RERANKER
  rerank: 'RERANKER',
  // GUARDRAIL
  guardrail: 'GUARDRAIL',
  check_guardrail: 'GUARDRAIL',
};

/**
 * Returns the display span kind across all supported conventions:
 *   - OpenInference: openinference.span.kind (AGENT, LLM, CHAIN, TOOL, RETRIEVER, EMBEDDING, RERANKER)
 *   - OTel GenAI:    gen_ai.operation.name mapped to normalized labels
 *   - GCP Vertex:    derives LLM from gen_ai.operation.name or gen_ai.system presence
 * Returns undefined for non-AI spans.
 */
export function getSpanKind(tags: KeyValuePair[]): string | undefined {
  // OpenInference — explicit kind attribute, trust it directly
  const oiKind = getAttr(tags, 'openinference.span.kind');
  if (oiKind) {
    return oiKind.toUpperCase();
  }

  // OTel GenAI / Vertex — derive kind from gen_ai.operation.name
  const opName = getAttr(tags, 'gen_ai.operation.name');
  if (opName) {
    return OTEL_OPERATION_TO_KIND[opName.toLowerCase()] ?? opName.toUpperCase();
  }

  // Fallback: any span with gen_ai.system, gen_ai.request.model, llm.model_name, or
  // llm.request.type is an LLM inference span with no explicit kind — show "LLM"
  const isInferenceSpan = tags.some(
    (t) =>
      t.key === 'gen_ai.system' ||
      t.key === 'gen_ai.request.model' ||
      t.key === 'llm.model_name' ||
      t.key === 'llm.request.type'
  );
  if (isInferenceSpan) {
    return 'LLM';
  }

  return undefined;
}

/**
 * Returns the agent name across all supported conventions:
 *   - gen_ai.agent.name  (OTel GenAI spec + modern OpenInference ≥ 1.4)
 * Returns undefined when no agent name attribute is found.
 */
export function getAgentName(tags: KeyValuePair[]): string | undefined {
  return getAttr(tags, 'gen_ai.agent.name');
}

export function getSpanKindColor(kind: string | undefined): string {
  switch (kind?.toUpperCase()) {
    case 'LLM': return '#7B61FF';
    case 'CHAIN': return '#3274D9';
    case 'AGENT': return '#E0851A';
    case 'TOOL': return '#5794F2';
    case 'RETRIEVER': return '#73BF69';
    case 'EMBEDDING': return '#B877D9';
    case 'RERANKER': return '#FF9830';
    case 'GUARDRAIL': return '#F59E0B';
    case 'UNKNOWN': return '#6B7280';
    default: return '#8E8E8E';
  }
}
