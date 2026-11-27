import assert from 'node:assert/strict';
import { get } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseOptions } from '../src/cli/options.js';
import { openGui, type GuiExtensions } from '../src/gui/index.js';
import type { Model } from '../src/types.js';
import type { TestContext } from 'node:test';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'workbench-gui-'));
  const workspace = join(root, 'workspace');
  const state = join(root, 'state');
  const env = join(root, 'fixture.env');
  t.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(workspace);
  mkdirSync(join(workspace, '.agent'));
  const policy = join(root, 'policy.json');
  writeFileSync(
    policy,
    JSON.stringify({
      commands: { allow: [], deny: [] },
      directories: { allow: ['.'], deny: ['private'] },
    }),
  );
  writeFileSync(join(workspace, 'readme.txt'), 'Expected file');
  writeFileSync(join(workspace, '.agent', 'internal.txt'), 'Project settings');
  writeFileSync(
    env,
    'AGENT_PROVIDER=ollama\nOPENAI_API_KEY=very-private-key\nOPENAI_MODEL=qwen3\n',
  );
  const args = [
    'gui',
    '--workspace',
    workspace,
    '--policy',
    policy,
    '--state-dir',
    state,
    '--env-file',
    env,
    '--no-mcp',
  ];
  return { options: parseOptions(args), root, workspace, state };
}

async function setup(t: TestContext, extensions: GuiExtensions = {}) {
  const { options, workspace, state } = fixture(t);
  const app = await openGui(options, extensions);
  // Register close after the fixture. Each request is fully consumed in tests.
  t.after(() => app.close());
  const local = (path: string) => new URL(path, app.url);
  const boot = await (await fetch(local('/api/bootstrap'))).json();
  const origin = new URL(app.url).origin;
  function post(path: string, data: unknown, headers: HeadersInit = {}) {
    return fetch(local(path), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        'x-workbench-token': boot.token,
        ...headers,
      },
      body: JSON.stringify(data),
    });
  }
  return { ...app, local, boot, post, workspace, state, options };
}

test('browser service enforces origin and token, protects config and exposes safe settings and trusted assets', async (t) => {
  const app = await setup(t, { market: { list: () => ({ entries: [{ id: 'local-skill' }] }) } });
  const html = await fetch(app.local('/'), { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/u);
  assert.match(await html.text(), /<title>Workbench/u);
  for (const path of ['/style.css', '/app.js'])
    assert.equal((await fetch(app.local(path))).status, 200);
  assert.doesNotMatch(JSON.stringify(app.boot), /very-private-key|apiKey/u);
  assert.equal(
    (await fetch(app.local('/api/bootstrap'), { headers: { origin: 'https://outside.invalid' } }))
      .status,
    403,
  );
  assert.equal(
    (await fetch(app.local('/api/bootstrap'), { headers: { 'sec-fetch-site': 'cross-site' } }))
      .status,
    403,
  );
  const forgedHost = await new Promise<number | undefined>((resolve, reject) => {
    get(app.local('/api/bootstrap'), { headers: { host: 'outside.invalid' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).once('error', reject);
  });
  assert.equal(forgedHost, 403);
  assert.equal(
    (await app.post('/api/settings', { effort: 'high' }, { 'x-workbench-token': 'wrong' })).status,
    403,
  );
  assert.equal(
    (await app.post('/api/settings', { effort: 'high' }, { origin: 'https://outside.invalid' }))
      .status,
    403,
  );
  const settings = await app.post('/api/settings', { model: 'qwen3:4b', effort: 'low' });
  assert.equal(settings.status, 200);
  assert.equal((await settings.json()).reasoningEffort, 'low');
  const reopened = await openGui(app.options);
  t.after(() => reopened.close());
  const saved = await (await fetch(new URL('/api/bootstrap', reopened.url))).json();
  assert.equal(saved.settings.model, 'qwen3:4b');
  assert.equal(saved.settings.reasoningEffort, 'low');
  assert.doesNotMatch(
    readFileSync(join(app.state, 'gui-settings.json'), 'utf8'),
    /very-private-key/u,
  );
  assert.equal((await fetch(app.local('/api/file?path=../fixture.env'))).status, 400);
  assert.equal((await fetch(app.local('/api/file?path=.agent/internal.txt'))).status, 400);
  assert.deepEqual((await (await fetch(app.local('/api/files'))).json()).files, ['readme.txt']);
  assert.deepEqual(await (await app.post('/api/market/list', {})).json(), {
    entries: [{ id: 'local-skill' }],
  });
});

function frames(body: string) {
  return body
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('streamed GUI chat confirms file effects, resumes the session and exposes logs, stats, doctor and rollback', async (t) => {
  let calls = 0;
  const model: Model = {
    async complete(messages, _tools, observe) {
      calls += 1;
      if (calls === 1) {
        observe?.({ type: 'thinking' });
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'edit',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({ path: 'answer.txt', content: 'new contents' }),
                },
              },
            ],
          },
          usage: { input: 6, output: 2 },
        };
      }
      assert.ok(messages.some((message) => message.role === 'tool'));
      observe?.({ type: 'text', text: 'Сохранено' });
      return {
        message: { role: 'assistant', content: 'Сохранено' },
        usage: { input: 8, output: 2 },
      };
    },
  };
  const app = await setup(t, { model, mcp: { list: () => ({ servers: [] }) } });
  assert.deepEqual(await (await app.post('/api/mcp/list', {})).json(), { servers: [] });
  const started = await app.post('/api/run', { prompt: 'Сохрани ответ', mode: 'safe' });
  assert.match(started.headers.get('content-type') ?? '', /ndjson/u);
  const first = frames(await started.text());
  const pending = first.at(-1).result;
  assert.equal(pending.status, 'awaiting_confirmation');
  assert.equal(pending.pending.tool, 'write_file');
  assert.equal(existsSync(join(app.workspace, 'answer.txt')), false);
  assert.ok(first.some((frame) => frame.progress?.type === 'thinking'));
  const resumed = frames(
    await (await app.post('/api/resume', { runId: pending.id, decision: 'approve' })).text(),
  );
  assert.equal(resumed.at(-1).result.status, 'completed');
  assert.ok(resumed.some((frame) => frame.progress?.text === 'Сохранено'));
  assert.equal(readFileSync(join(app.workspace, 'answer.txt'), 'utf8'), 'new contents');
  const session = await (await fetch(app.local(`/api/session/${pending.sessionId}`))).json();
  assert.equal(session.runs[0].final, 'Сохранено');
  assert.equal(session.stats.usage.input.total, 14);
  assert.equal((await fetch(app.local(`/api/doctor/${pending.sessionId}`))).status, 200);
  const logs = await (await fetch(app.local(`/api/logs/${pending.id}`))).json();
  assert.ok(logs.some(({ type }: { type: string }) => type === 'tool_result'));
  const diff = await (await fetch(app.local(`/api/diff/${pending.id}`))).json();
  assert.match(diff[0].text, /\+new contents/u);
  assert.equal((await app.post('/api/rollback', { runId: pending.id })).status, 200);
  assert.equal(existsSync(join(app.workspace, 'answer.txt')), false);
});
