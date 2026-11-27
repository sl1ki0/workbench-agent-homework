import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AssistantMessage, Message } from '../src/types.js';

test('terminal chat denies an action and keeps conversational context for the follow-up', async (t) => {
  const temp = mkdtempSync(join(realpathSync(tmpdir()), 'agent-cli-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  cpSync('workspace', join(temp, 'workspace'), { recursive: true });
  const requests: Message[][] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const { messages } = JSON.parse(Buffer.concat(chunks).toString()) as { messages: Message[] };
    requests.push(messages);
    const last = messages.at(-1);
    const assistant: AssistantMessage = { role: 'assistant', content: null };
    if (last?.content === 'Write my note.') {
      assistant.tool_calls = [
        {
          id: 'call-note',
          type: 'function',
          function: { name: 'write_file', arguments: '{"path":"note.md","content":"My note"}' },
        },
      ];
    } else {
      assistant.content = last?.role === 'tool' ? 'The note was not written.' : 'Context retained.';
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        choices: [{ message: assistant }],
        usage: { prompt_tokens: 40, completion_tokens: 4 },
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  const child = spawn(
    process.execPath,
    [
      'dist/src/cli/index.js',
      'chat',
      '--workspace',
      join(temp, 'workspace'),
      '--state-dir',
      join(temp, 'state'),
      '--no-skills',
      '--no-mcp',
    ],
    {
      env: {
        ...process.env,
        AGENT_PROVIDER: 'compatible',
        OPENAI_MODEL: 'test-model',
        OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
        OPENAI_TIMEOUT_MS: '5000',
      },
    },
  );
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stdin.end('Write my note.\n/deny\nAnd what happened?\n/stats\n/exit\n');
  const [code] = await once(child, 'close');

  assert.equal(code, 0, output);
  assert.equal(requests.length, 3, output);
  assert.match(requests[1]?.at(-1)?.content ?? '', /User (denied|declined)/u);
  assert.deepEqual(requests[2]?.slice(-3), [
    { role: 'user', content: 'Write my note.' },
    { role: 'assistant', content: 'The note was not written.' },
    { role: 'user', content: 'And what happened?' },
  ]);
  assert.equal(existsSync(join(temp, 'workspace', 'note.md')), false);
  assert.match(output, /запусков 2 · запросов к модели 3/u);
  assert.doesNotMatch(output, /\u001b/u);
});
