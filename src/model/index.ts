import { randomUUID } from 'node:crypto';
import type { AssistantMessage, Message, ModelReply, ToolDefinition } from '../types.js';

const OLLAMA_URL = 'http://127.0.0.1:11434/v1/';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/';
const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export interface ModelSettings {
  provider: 'ollama' | 'openrouter' | 'compatible';
  endpoint: string;
  model: string;
  timeoutMs: number;
  temperature: number;
  maxTokens: number;
  seed?: number;
  reasoningEffort?: string;
}

function readNumber(
  key: string,
  env: NodeJS.ProcessEnv,
  accept: (value: number) => boolean,
): number | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || !accept(value)) throw new Error(`Некорректное значение ${key}`);
  return value;
}

const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;
const validTimeout = (value: number) => positiveInteger(value) && value <= 2_147_483_647;

export function readModelConfig(env: NodeJS.ProcessEnv = process.env): ModelSettings {
  const requested = env.AGENT_PROVIDER?.trim();
  if (requested && !['ollama', 'openrouter', 'compatible'].includes(requested)) {
    throw new Error('AGENT_PROVIDER должен быть ollama, openrouter или compatible');
  }

  const customUrl = env.OPENAI_BASE_URL?.trim();
  const base = customUrl || (requested === 'openrouter' ? OPENROUTER_URL : OLLAMA_URL);
  if (requested === 'compatible' && !customUrl) {
    throw new Error('Для AGENT_PROVIDER=compatible укажите OPENAI_BASE_URL');
  }
  const endpoint = new URL(base);
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('OPENAI_BASE_URL должен быть HTTP(S) URL без учётных данных и параметров');
  }
  if (!endpoint.pathname.endsWith('/chat/completions')) {
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, '')}/chat/completions`;
  }

  let provider: ModelSettings['provider'] = 'compatible';
  if (endpoint.hostname === 'openrouter.ai' || requested === 'openrouter') {
    provider = 'openrouter';
  } else if (endpoint.port === '11434' || requested === 'ollama') {
    provider = 'ollama';
  }

  const model = env.OPENAI_MODEL?.trim() || (provider === 'ollama' ? 'qwen3:4b' : '');
  if (!model) throw new Error('Укажите OPENAI_MODEL с поддержкой tool calling');

  const reasoningEffort = env.OPENAI_REASONING_EFFORT?.trim() || undefined;
  if (reasoningEffort && !reasoningEfforts.includes(reasoningEffort)) {
    throw new Error(`OPENAI_REASONING_EFFORT должен быть одним из ${reasoningEfforts.join(', ')}`);
  }
  const seed = readNumber('OPENAI_SEED', env, Number.isSafeInteger);

  return {
    provider,
    endpoint: endpoint.toString(),
    model,
    timeoutMs: readNumber('OPENAI_TIMEOUT_MS', env, validTimeout) ?? 180_000,
    temperature: readNumber('OPENAI_TEMPERATURE', env, (value) => value >= 0 && value <= 2) ?? 0,
    maxTokens: readNumber('OPENAI_MAX_TOKENS', env, positiveInteger) ?? 4_096,
    ...(seed === undefined ? {} : { seed }),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function extractUsage(value: unknown): NonNullable<ModelReply['usage']> | undefined {
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

function extractMessage(value: unknown): AssistantMessage {
  const message = record(value);
  if (message.role !== 'assistant') throw new Error('Модель не вернула сообщение assistant');
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.map(extractToolCall) : [];
  const content = typeof message.content === 'string' ? message.content : null;
  if (!content?.trim() && calls.length === 0) throw new Error('Модель вернула пустой ответ');
  return { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) };
}

export class OpenAICompatibleModel {
  constructor(
    readonly settings: ModelSettings,
    private readonly apiKey: string,
    private readonly fetchRequest: typeof fetch = fetch,
  ) {}

  async complete(messages: Message[], tools: ToolDefinition[]): Promise<ModelReply> {
    const settings = this.settings;
    const functions = tools.map(({ name, description, schema }) => ({
      type: 'function',
      function: { name, description, parameters: schema },
    }));
    const params = {
      model: settings.model,
      messages,
      stream: false,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      ...(settings.seed === undefined ? {} : { seed: settings.seed }),
      ...(settings.reasoningEffort ? { reasoning_effort: settings.reasoningEffort } : {}),
      ...(functions.length ? { tools: functions, tool_choice: 'auto' } : {}),
    };

    let status: number | undefined;
    let result: Record<string, unknown>;
    const signal = AbortSignal.timeout(settings.timeoutMs);
    try {
      const response = await this.fetchRequest(settings.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        redirect: 'error',
        signal,
        body: JSON.stringify(params),
      });
      status = response.status;
      result = record(await response.json());
    } catch {
      if (signal.aborted) throw new Error(`Таймаут запроса к модели (${settings.timeoutMs} мс)`);
      if (status !== undefined) throw new Error(`Модель вернула невалидный JSON (HTTP ${status})`);
      throw new Error(
        'Сбой соединения с моделью. Проверьте OPENAI_BASE_URL и доступность сервера.',
      );
    }

    const usage = extractUsage(result.usage);
    if (status >= 400 || result.error) {
      const detail = record(result.error).message ?? result.error;
      let safeDetail = typeof detail === 'string' ? detail : '';
      if (this.apiKey) safeDetail = safeDetail.replaceAll(this.apiKey, '[redacted]');
      throw new ModelResponseError(
        `API модели вернул ошибку HTTP ${status}${safeDetail ? ` · ${safeDetail.slice(0, 500)}` : ''}`,
        usage,
      );
    }

    const choice = record(Array.isArray(result.choices) ? result.choices[0] : undefined);
    if (choice.finish_reason === 'length') {
      throw new ModelResponseError('Ответ модели прерван лимитом OPENAI_MAX_TOKENS', usage);
    }
    try {
      return { message: extractMessage(choice.message), ...(usage ? { usage } : {}) };
    } catch (error) {
      throw new ModelResponseError(error instanceof Error ? error.message : String(error), usage);
    }
  }
}

export class ModelResponseError extends Error {
  constructor(
    message: string,
    readonly usage?: ModelReply['usage'],
  ) {
    super(message);
    this.name = 'ModelResponseError';
  }
}

export function makeModel(env: NodeJS.ProcessEnv = process.env): OpenAICompatibleModel {
  const settings = readModelConfig(env);
  const openRouterKey = settings.provider === 'openrouter' ? env.OPENROUTER_API_KEY?.trim() : '';
  const apiKey = openRouterKey || env.OPENAI_API_KEY?.trim();
  if (!apiKey && settings.provider === 'openrouter') {
    throw new Error('Для OpenRouter укажите OPENROUTER_API_KEY или OPENAI_API_KEY');
  }
  return new OpenAICompatibleModel(settings, apiKey ?? '');
}
