import { randomUUID } from 'node:crypto';
import type { AssistantMessage, ModelProgress, ModelReply } from '../types.js';

export type ModelObserver = (progress: ModelProgress) => void;

export class ModelResponseError extends Error {
  constructor(
    message: string,
    readonly usage?: ModelReply['usage'],
  ) {
    super(message);
    this.name = 'ModelResponseError';
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function extractUsage(value: unknown): NonNullable<ModelReply['usage']> | undefined {
  const source = record(value);
  const input = tokenCount(source.prompt_tokens);
  const output = tokenCount(source.completion_tokens);
  const cached = tokenCount(record(source.prompt_tokens_details).cached_tokens);
  const reasoning = tokenCount(record(source.completion_tokens_details).reasoning_tokens);
  if ([input, output, cached, reasoning].every((count) => count === undefined)) return undefined;
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cached === undefined ? {} : { cached }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

type ToolCall = NonNullable<AssistantMessage['tool_calls']>[number];

function extractToolCall(value: unknown): ToolCall {
  const call = record(value);
  const fn = record(call.function);
  if (call.type !== 'function' || typeof fn.name !== 'string' || !fn.name) {
    throw new Error('Модель вернула некорректный tool call');
  }
  const args =
    typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? null);
  return {
    id: typeof call.id === 'string' && call.id ? call.id : `call_${randomUUID()}`,
    type: 'function',
    function: { name: fn.name, arguments: args },
  };
}

export function extractMessage(value: unknown): AssistantMessage {
  const message = record(value);
  if (message.role !== 'assistant') throw new Error('Модель не вернула сообщение assistant');
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.map(extractToolCall) : [];
  const content = typeof message.content === 'string' ? message.content : null;
  if (!content?.trim() && calls.length === 0) throw new Error('Модель вернула пустой ответ');
  return { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) };
}

export function hasThinking(delta: Record<string, unknown>): boolean {
  return [delta.reasoning_content, delta.reasoning, delta.thinking, delta.reasoning_details].some(
    (part) => (typeof part === 'string' || Array.isArray(part)) && part.length > 0,
  );
}

export function assertFinish(reason: unknown, usage: ModelReply['usage']): void {
  if (reason === 'length') {
    throw new ModelResponseError('Ответ модели прерван лимитом OPENAI_MAX_TOKENS', usage);
  }
  if (reason === 'error' || reason === 'content_filter') {
    throw new ModelResponseError('Провайдер прервал ответ модели', usage);
  }
}

export function apiError(
  status: number,
  value: unknown,
  apiKey: string,
  usage: ModelReply['usage'],
): ModelResponseError {
  const detail = record(value).message ?? value;
  let safeDetail = typeof detail === 'string' ? detail : '';
  if (apiKey) safeDetail = safeDetail.replaceAll(apiKey, '[redacted]');
  return new ModelResponseError(
    `API модели вернул ошибку HTTP ${status}${safeDetail ? ` · ${safeDetail.slice(0, 500)}` : ''}`,
    usage,
  );
}
