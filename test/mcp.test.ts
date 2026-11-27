import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openMcp } from '../src/mcp/index.js';
import { Agent } from '../src/runtime/index.js';
import type { Model, ToolCall } from '../src/types.js';
import { readPolicy, Workspace } from '../src/workspace/index.js';

const tracker = fileURLToPath(new URL('../src/mcp/tracker-server.js', import.meta.url));
const defaultConfig = join(process.cwd(), 'config/mcp.json');

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'course-mcp-'));
  const root = join(directory, 'workspace');
  mkdirSync(root);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    workspace: new Workspace(root, readPolicy(join(process.cwd(), 'config/policy.json'))),
    stateDir: join(directory, 'state'),
  };
}

function config(
  directory: string,
  id: string,
  entry: string,
  allowReadOnly: string[],
  timeoutMs = 3000,
) {
  const path = join(directory, 'mcp.json');
  writeFileSync(
    path,
    JSON.stringify({
      servers: { [id]: { command: 'node', args: [entry], allowReadOnly, timeoutMs } },
    }),
  );
  return path;
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

test('real MCP lists tools, returns data and records call identity and server errors in a safe run', async (t) => {
  const mcp = await openMcp(defaultConfig);
  t.after(mcp.dispose);
  assert.deepEqual(mcp.initialEvents, [
    {
      type: 'mcp_connected',
      data: {
        server: 'tracker',
        tools: ['mcp_tracker_list_tasks', 'mcp_tracker_get_task'],
        denied: [],
      },
    },
  ]);
  const model: Model = {
    async complete(messages, tools) {
      const list = tools.find(({ name }) => name === 'mcp_tracker_list_tasks');
      assert.ok(list);
      assert.ok(list.description.includes('educational tracker'));
      assert.deepEqual(list.schema.properties, {
        status: { type: 'string', enum: ['open', 'closed', 'all'] },
      });
      if (messages.some(({ role }) => role === 'tool')) {
        assert.ok(
          messages.some(
            (entry) =>
              entry.role === 'tool' &&
              entry.tool_call_id === 'open' &&
              entry.content.includes('T4'),
          ),
        );
        assert.ok(
          messages.some(
            (entry) =>
              entry.role === 'tool' &&
              entry.tool_call_id === 'absent' &&
              entry.content.includes('not found'),
          ),
        );
        return { message: { role: 'assistant', content: 'Трекер прочитан' } };
      }
      return {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            call('open', 'mcp_tracker_list_tasks', { status: 'open' }),
            call('absent', 'mcp_tracker_get_task', { id: 'T999' }),
          ],
        },
      };
    },
  };
  const agent = new Agent({ ...fixture(t), model, ...mcp });
  const run = await agent.start({ prompt: 'Покажи открытые задачи.', mode: 'safe' });
  assert.equal(run.status, 'completed');
  assert.deepEqual(
    run.records.map((record) => record.result.ok),
    [true, false],
  );
  const result = run.records[0]?.result.output as { tasks: { id: string }[]; count: number };
  assert.equal(result.count, 3);
  assert.deepEqual(
    result.tasks.map(({ id }) => id),
    ['T1', 'T3', 'T4'],
  );
  assert.ok(
    run.events.some(
      ({ type, data }) =>
        type === 'tool_result' && data.server === 'tracker' && data.tool === 'list_tasks',
    ),
  );
  assert.ok(
    run.events.some(
      ({ type, data }) =>
        type === 'tool_error' && data.server === 'tracker' && data.tool === 'get_task',
    ),
  );
  assert.deepEqual(agent.stats(run.sessionId).mcp, {
    'tracker/list_tasks': 1,
    'tracker/get_task': 1,
  });
});

test('configured MCP allow-list hides the tool and records a policy refusal for a guessed call', async (t) => {
  const project = fixture(t);
  const mcp = await openMcp(config(project.directory, 'restricted', tracker, ['list_tasks']));
  t.after(mcp.dispose);
  const model: Model = {
    async complete(messages, tools) {
      assert.equal(
        tools.some(({ name }) => name === 'mcp_restricted_get_task'),
        false,
      );
      assert.equal(
        tools.some(({ name }) => name === 'mcp_restricted_list_tasks'),
        true,
      );
      return {
        message: messages.some(({ role }) => role === 'tool')
          ? { role: 'assistant', content: 'Доступ запрещён' }
          : {
              role: 'assistant',
              content: null,
              tool_calls: [call('deny', 'mcp_restricted_get_task', { id: 'T1' })],
            },
      };
    },
  };
  const run = await new Agent({ ...project, model, ...mcp }).start({
    prompt: 'Прочитай T1.',
    mode: 'auto',
  });
  assert.equal(run.status, 'completed');
  assert.match(run.records[0]?.result.error ?? '', /read-only policy denied/);
  assert.ok(
    run.events.some(
      ({ type, data }) =>
        type === 'tool_denied' && data.server === 'restricted' && data.tool === 'get_task',
    ),
  );
});

test('an alternate stdio tool times out and a write-capable tool remains blocked', async (t) => {
  const { directory } = fixture(t);
  const path = join(directory, 'alternate.mjs');
  writeFileSync(
    path,
    `
import { Server } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};

const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'wait', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'change', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
] }));
server.setRequestHandler(CallToolRequestSchema, () => new Promise(() => {}));
await server.connect(new StdioServerTransport());
`,
  );
  const mcp = await openMcp(config(directory, 'alternate', path, ['wait', 'change'], 800));
  t.after(mcp.dispose);
  const reader = mcp.tools.find(({ name }) => name === 'mcp_alternate_wait');
  const writer = mcp.tools.find(({ name }) => name === 'mcp_alternate_change');
  assert.ok(reader && !reader.hidden);
  assert.ok(writer?.hidden);
  assert.throws(() => writer.authorize?.({}), /read-only policy denied/);
  const result = await reader.execute({}, { maxBytes: 1024, runId: 'run', sessionId: 'session' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /MCP alternate\/wait:.*timed out/i);
});
