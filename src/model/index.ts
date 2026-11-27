import type { Message, Model, ModelReply, ToolDefinition } from '../types.js';
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
import { readCompletionStream } from './stream.js';
import { VisibleText } from './visible-text.js';

export { ModelResponseError } from './protocol.js';

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

function qwenMessages(messages: Message[], effort: string | undefined): Message[] {
  if (!effort) return messages;
  const index = messages.findLastIndex((message) => message.role === 'user');
  if (index === -1) return messages;
  const directive = effort === 'none' ? '/no_think' : '/think';
  return messages.map((message, position) =>
    position === index && message.role === 'user'
      ? { ...message, content: `${message.content}\n\n${directive}` }
      : message,
  );
}

export class OpenAICompatibleModel implements Model {
  constructor(
    readonly settings: ModelSettings,
    private readonly apiKey: string,
    private readonly fetchRequest: typeof fetch = fetch,
  ) {}

  async complete(
    messages: Message[],
    tools: ToolDefinition[],
    observe?: ModelObserver,
  ): Promise<ModelReply> {
    const settings = this.settings;
    const implicitThinking =
      settings.provider === 'ollama' && /(?:^|[-/])qwen3(?::|$)/iu.test(settings.model);
    const functions = tools.map(({ name, description, schema }) => ({
      type: 'function',
      function: { name, description, parameters: schema },
    }));
    const params = {
      model: settings.model,
      messages: implicitThinking ? qwenMessages(messages, settings.reasoningEffort) : messages,
      stream: Boolean(observe),
      ...(observe ? { stream_options: { include_usage: true } } : {}),
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      ...(settings.seed === undefined ? {} : { seed: settings.seed }),
      ...(settings.reasoningEffort ? { reasoning_effort: settings.reasoningEffort } : {}),
      ...(functions.length ? { tools: functions, tool_choice: 'auto' } : {}),
    };

    const timeoutMessage = `Таймаут запроса к модели (${settings.timeoutMs} мс)`;
    const signal = AbortSignal.timeout(settings.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchRequest(settings.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(observe ? { Accept: 'text/event-stream, application/json' } : {}),
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        redirect: 'error',
        signal,
        body: JSON.stringify(params),
      });
    } catch {
      if (signal.aborted) throw new Error(timeoutMessage);
      throw new Error(
        'Сбой соединения с моделью. Проверьте OPENAI_BASE_URL и доступность сервера.',
      );
    }

    if (
      observe &&
      response.ok &&
      response.headers.get('content-type')?.includes('text/event-stream')
    ) {
      if (!response.body) throw new ModelResponseError('Поток ответа модели пуст');
      return readCompletionStream(response.body, observe, {
        status: response.status,
        apiKey: this.apiKey,
        signal,
        timeoutMessage,
        implicitThinking,
      });
    }

    let result: Record<string, unknown>;
    try {
      result = record(await response.json());
    } catch {
      if (signal.aborted) throw new Error(timeoutMessage);
      throw new Error(`Модель вернула невалидный JSON (HTTP ${response.status})`);
    }

    const usage = extractUsage(result.usage);
    if (!response.ok || result.error)
      throw apiError(response.status, result.error, this.apiKey, usage);
    const choice = record(Array.isArray(result.choices) ? result.choices[0] : undefined);
    assertFinish(choice.finish_reason, usage);
    try {
      const reply = record(choice.message);
      const raw = typeof reply.content === 'string' ? reply.content : '';
      const firstTag = /<think>|<\/think>/iu.exec(raw)?.[0]?.toLowerCase();
      const orphanClose = firstTag === '</think>';
      const text = new VisibleText(observe, implicitThinking || orphanClose);
      if (hasThinking(reply) && !orphanClose) text.structuredThinking();
      text.add(raw);
      const toolsProvided = Array.isArray(reply.tool_calls) && reply.tool_calls.length > 0;
      const message = extractMessage({ ...reply, content: text.finish(!toolsProvided) });
      for (const call of message.tool_calls ?? [])
        observe?.({ type: 'tool', name: call.function.name });
      return { message, ...(usage ? { usage } : {}) };
    } catch (error) {
      throw new ModelResponseError(error instanceof Error ? error.message : String(error), usage);
    }
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
