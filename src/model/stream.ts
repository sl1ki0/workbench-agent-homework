import type { ModelReply } from '../types.js';
import {
  apiError,
  assertFinish,
  extractMessage,
  extractUsage,
  hasThinking,
  ModelResponseError,
  record,
  type ModelObserver,
} from './protocol.js';
import { readSse } from './sse.js';
import { VisibleText } from './visible-text.js';

interface ToolFragments {
  id?: string;
  type: string;
  function: { name: string; arguments: string };
}

function mergeTool(tools: Map<number, ToolFragments>, input: unknown, fallbackIndex: number): void {
  const delta = record(input);
  const index = delta.index ?? fallbackIndex;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw new Error('Модель вернула некорректный индекс tool call');
  }
  const current = tools.get(index) ?? {
    type: 'function',
    function: { name: '', arguments: '' },
  };
  if (typeof delta.id === 'string' && delta.id !== current.id) {
    current.id = (current.id ?? '') + delta.id;
  }
  if (typeof delta.type === 'string') current.type = delta.type;
  const fn = record(delta.function);
  if (typeof fn.name === 'string') current.function.name += fn.name;
  if (typeof fn.arguments === 'string') current.function.arguments += fn.arguments;
  else if (fn.arguments && typeof fn.arguments === 'object') {
    current.function.arguments += JSON.stringify(fn.arguments);
  }
  tools.set(index, current);
}

function decodeChunk(payload: string): Record<string, unknown> {
  try {
    const chunk: unknown = JSON.parse(payload);
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw new Error();
    return record(chunk);
  } catch {
    throw new Error('Модель вернула невалидное событие SSE');
  }
}

export async function readCompletionStream(
  body: ReadableStream<Uint8Array>,
  observe: ModelObserver,
  request: {
    status: number;
    apiKey: string;
    signal: AbortSignal;
    timeoutMessage: string;
    implicitThinking: boolean;
  },
): Promise<ModelReply> {
  let usage: ModelReply['usage'];
  let finish: unknown;
  let done = false;
  const text = new VisibleText(observe, request.implicitThinking);
  const tools = new Map<number, ToolFragments>();

  try {
    for await (const payload of readSse(body)) {
      if (payload.trim() === '[DONE]') {
        done = true;
        break;
      }
      if (!payload.trim()) continue;
      const chunk = decodeChunk(payload);
      const sample = extractUsage(chunk.usage);
      if (sample) usage = { ...usage, ...sample };
      if (chunk.error) throw apiError(request.status, chunk.error, request.apiKey, usage);
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = record(choices.find((entry, index) => (record(entry).index ?? index) === 0));
      if (choice.finish_reason != null) finish = choice.finish_reason;
      const delta = record(choice.delta);
      if (hasThinking(delta)) text.structuredThinking();
      if (typeof delta.content === 'string') text.add(delta.content);
      if (Array.isArray(delta.tool_calls)) {
        delta.tool_calls.forEach((part, index) => mergeTool(tools, part, index));
      }
    }

    if (!done && finish == null) throw new Error('Поток ответа модели оборвался');
    assertFinish(finish, usage);
    const message = extractMessage({
      role: 'assistant',
      content: text.finish(tools.size === 0),
      tool_calls: [...tools].sort(([a], [b]) => a - b).map(([, tool]) => tool),
    });
    for (const call of message.tool_calls ?? [])
      observe({ type: 'tool', name: call.function.name });
    return { message, ...(usage ? { usage } : {}) };
  } catch (error) {
    if (error instanceof ModelResponseError) throw error;
    const failure = error instanceof Error ? error.message : 'Ошибка потока ответа модели';
    throw new ModelResponseError(request.signal.aborted ? request.timeoutMessage : failure, usage);
  }
}
