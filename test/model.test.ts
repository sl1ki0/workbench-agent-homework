import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelResponseError, OpenAICompatibleModel, readModelConfig } from '../src/model/index.js';
import type { Message, ToolDefinition } from '../src/types.js';

const messages: Message[] = [
  { role: 'user', content: 'Check the report.' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'search-1', type: 'function', function: { name: 'list_files', arguments: '{}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'search-1', content: '{"paths":["report.md"]}' },
];
const readTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  sideEffect: false,
  safeRetry: true,
  execute: async () => ({ ok: true }),
};

test('OpenAI-compatible model preserves tool IDs, exports schemas, and reports API usage separately', async () => {
  const settings = readModelConfig({
    AGENT_PROVIDER: 'openrouter',
    OPENAI_MODEL: 'example/model',
    OPENAI_SEED: '37',
  });
  const model = new OpenAICompatibleModel(settings, 'test-key', async (input, init) => {
    assert.equal(input, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-key');
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request.messages, messages);
    assert.equal(request.seed, 37);
    assert.deepEqual(request.tools, [
      {
        type: 'function',
        function: { name: 'read_file', description: 'Read a file', parameters: readTool.schema },
      },
    ]);
    return Response.json({
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'read-1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"report.md"}' },
              },
              {
                id: 'read-2',
                type: 'function',
                function: { name: 'read_file', arguments: { path: 'notes.md' } },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 27,
        completion_tokens: 9,
        prompt_tokens_details: { cached_tokens: 11 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    });
  });

  const reply = await model.complete(messages, [readTool]);
  assert.deepEqual(
    reply.message.tool_calls?.map((call) => [call.id, call.function.arguments]),
    [
      ['read-1', '{"path":"report.md"}'],
      ['read-2', '{"path":"notes.md"}'],
    ],
  );
  assert.deepEqual(reply.usage, { input: 27, output: 9, cached: 11, reasoning: 3 });
});

test('response errors preserve partial usage and redact credentials', async () => {
  const model = new OpenAICompatibleModel(readModelConfig({}), 'test-secret', async () =>
    Response.json(
      {
        error: { message: 'Unauthorized: test-secret' },
        usage: { prompt_tokens: 5 },
      },
      { status: 401 },
    ),
  );

  await assert.rejects(model.complete(messages, []), (error: unknown) => {
    assert.ok(error instanceof ModelResponseError);
    assert.doesNotMatch(error.message, /test-secret/u);
    assert.match(error.message, /401/u);
    assert.deepEqual(error.usage, { input: 5 });
    return true;
  });
});
