import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelResponseError, OpenAICompatibleModel, readModelConfig } from '../src/model/index.js';
import type { ModelProgress } from '../src/types.js';

const headers = { 'content-type': 'text/event-stream; charset=utf-8' };
const encoder = new TextEncoder();
const settings = readModelConfig({ OPENAI_MODEL: 'mock-model', OPENAI_REASONING_EFFORT: 'low' });

function event(data: unknown, end = '\r\n'): string {
  return `data: ${JSON.stringify(data)}${end}${end}`;
}

function choice(delta: unknown, finish_reason: string | null = null) {
  return { choices: [{ index: 0, delta, finish_reason }] };
}

function splitResponse(source: string, chunkSize: number): Response {
  const bytes = encoder.encode(source);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          controller.enqueue(bytes.slice(offset, offset + chunkSize));
        }
        controller.close();
      },
    }),
    { headers },
  );
}

test(
  'visible SSE content arrives before completion and reasoning only signals activity',
  { timeout: 2_000 },
  async () => {
    const { readable, writable } = new TransformStream<Uint8Array>();
    const model = new OpenAICompatibleModel(settings, 'test-key', async (_, init) => {
      const request = JSON.parse(String(init?.body));
      assert.equal(request.stream, true);
      assert.deepEqual(request.stream_options, { include_usage: true });
      assert.equal(request.reasoning_effort, 'low');
      return new Response(readable, { headers });
    });
    const progress: ModelProgress[] = [];
    let markArrived: () => void = () => {};
    const arrived = new Promise<void>((resolve) => {
      markArrived = resolve;
    });
    const reply = model.complete([], [], (item) => {
      progress.push(item);
      if (item.type === 'text') markArrived();
    });

    const stream = writable.getWriter();
    await stream.write(
      encoder.encode(
        event(choice({ reasoning_content: 'private contents' })) +
          event(choice({ content: 'Привет' })),
      ),
    );
    await arrived;
    assert.deepEqual(progress, [{ type: 'thinking' }, { type: 'text', text: 'Привет' }]);
    await stream.write(
      encoder.encode(
        event(choice({ content: '!' }, 'stop')) +
          event({
            choices: [],
            usage: {
              prompt_tokens: 13,
              completion_tokens: 4,
              prompt_tokens_details: { cached_tokens: 2 },
              completion_tokens_details: { reasoning_tokens: 1 },
            },
          }) +
          'data: [DONE]\r\n\r\n',
      ),
    );
    assert.deepEqual(await reply, {
      message: { role: 'assistant', content: 'Привет!' },
      usage: { input: 13, output: 4, cached: 2, reasoning: 1 },
    });
  },
);

test('SSE collects interleaved tool fragments and emits only complete tool names', async () => {
  const first = choice({
    tool_calls: [
      { index: 1, id: 'call-b', type: 'function', function: { name: 'Bash', arguments: '{"' } },
      {
        index: 0,
        id: 'call-',
        type: 'function',
        function: { name: 'read_', arguments: '{"path":"' },
      },
    ],
  });
  const second = choice({
    tool_calls: [
      { index: 0, id: 'a', function: { name: 'file', arguments: 'заметка.md"}' } },
      { index: 1, id: 'call-b', function: { arguments: 'command":"pwd"}' } },
    ],
  });
  const source = [
    ': keepalive\r\n\r\n',
    event(first),
    event(second),
    event(choice({}, 'tool_calls')),
    'data: [DONE]\r\n\r\n',
  ].join('');
  const progress: ModelProgress[] = [];
  const model = new OpenAICompatibleModel(settings, '', async () => splitResponse(source, 1));
  const reply = await model.complete([], [], (item) => progress.push(item));

  assert.deepEqual(reply, {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-a',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"заметка.md"}' },
        },
        {
          id: 'call-b',
          type: 'function',
          function: { name: 'Bash', arguments: '{"command":"pwd"}' },
        },
      ],
    },
  });
  assert.deepEqual(progress, [
    { type: 'tool', name: 'read_file' },
    { type: 'tool', name: 'Bash' },
  ]);
});

test('splits inline thinking delimiters across SSE messages while keeping visible Unicode', async () => {
  const source =
    ['İ before <Th', 'ink> private', ' reasoning </thi', 'nk> after']
      .map((content) => event(choice({ content }), '\n'))
      .join('') + event(choice({}, 'stop'), '\n');
  const progress: ModelProgress[] = [];
  const model = new OpenAICompatibleModel(settings, '', async () => splitResponse(source, 17));
  const reply = await model.complete([], [], (item) => progress.push(item));
  assert.equal(reply.message.content, 'İ before  after');
  assert.deepEqual(progress, [
    { type: 'text', text: 'İ before ' },
    { type: 'thinking' },
    { type: 'text', text: ' after' },
  ]);
});

test('stream errors and length cutoffs preserve available usage and never dispatch incomplete tools', async () => {
  const pendingTool = choice({
    tool_calls: [{ index: 0, id: 'call-0', function: { name: 'Bash', arguments: '{"command":' } }],
  });
  const failures = [
    { stop: event(choice({}, 'length')) + 'data: [DONE]\r\n\r\n', expected: /OPENAI_MAX_TOKENS/u },
    { stop: event({ error: { message: 'Denied test-secret' } }), expected: /Denied \[redacted\]/u },
    { stop: '', expected: /оборвался/u },
  ];
  for (const { stop, expected } of failures) {
    const source = event(pendingTool) + event({ choices: [], usage: { prompt_tokens: 21 } }) + stop;
    const model = new OpenAICompatibleModel(settings, 'test-secret', async () =>
      splitResponse(source, 19),
    );
    const progress: ModelProgress[] = [];
    await assert.rejects(
      model.complete([], [], (item) => progress.push(item)),
      (error: unknown) => {
        assert.ok(error instanceof ModelResponseError);
        assert.match(error.message, expected);
        assert.deepEqual(error.usage, { input: 21 });
        return true;
      },
    );
    assert.deepEqual(progress, []);
  }
});

test('an endpoint may return one JSON completion when the caller observes streaming', async () => {
  const model = new OpenAICompatibleModel(settings, '', async () =>
    Response.json({
      choices: [{ message: { role: 'assistant', content: '<think>private</think>ok' } }],
    }),
  );
  const progress: ModelProgress[] = [];
  const reply = await model.complete([], [], (item) => progress.push(item));
  assert.equal(reply.message.content, 'ok');
  assert.deepEqual(progress, [{ type: 'thinking' }, { type: 'text', text: 'ok' }]);
});

test('Ollama Qwen keeps hidden prefixes private even when only the closing marker is streamed', async () => {
  const variant = { ...settings, model: 'workbench-qwen3:4b' };
  const source =
    event(choice({ content: 'private prefix </th' })) +
    event(choice({ content: 'ink>\norder' })) +
    event(choice({ content: '.py' }, 'stop'));
  const progress: ModelProgress[] = [];
  const model = new OpenAICompatibleModel(variant, '', async () => splitResponse(source, 7));
  const reply = await model.complete([], [], (item) => progress.push(item));
  assert.equal(reply.message.content, '\norder.py');
  assert.deepEqual(progress, [
    { type: 'thinking' },
    { type: 'text', text: '\norder' },
    { type: 'text', text: '.py' },
  ]);
});

test('Qwen legacy templates receive an explicit mode directive without changing conversation history', async () => {
  const messages = [
    { role: 'user' as const, content: 'List files' },
    { role: 'assistant' as const, content: 'Earlier answer' },
  ];
  for (const [reasoningEffort, directive] of [
    ['none', '/no_think'],
    ['low', '/think'],
  ]) {
    const model = new OpenAICompatibleModel(
      { ...settings, model: 'workbench-qwen3:4b', reasoningEffort },
      '',
      async (_, init) => {
        const request = JSON.parse(String(init?.body));
        assert.equal(request.reasoning_effort, reasoningEffort);
        assert.equal(request.messages[0].content, 'List files\n\n' + directive);
        assert.equal(request.messages[1].content, 'Earlier answer');
        return Response.json({
          choices: [{ message: { role: 'assistant', content: 'Visible reply' } }],
        });
      },
    );
    await model.complete(messages, []);
  }
  assert.equal(messages[0]?.content, 'List files');
});
