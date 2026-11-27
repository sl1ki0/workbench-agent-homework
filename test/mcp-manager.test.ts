import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpManager, searchMcpRegistry } from '../src/mcp/manager.js';

test('configured MCP overlays persist after reopening, remove a default and restore it', async (t) => {
  const state = mkdtempSync(join(realpathSync(tmpdir()), 'mcp-overlay-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const config = resolve('config/mcp.json');
  const original = readFileSync(config, 'utf8');
  const settings = JSON.parse(original) as { servers: Record<string, unknown> };
  const create = () => new McpManager(config, state);

  assert.equal(create().definitions()[0]?.id, 'tracker');
  assert.equal((await create().status())[0]?.status, 'connected');
  assert.throws(
    () => create().add('tracker', settings.servers.tracker, dirname(config)),
    /уже настроен/u,
  );
  create().remove('tracker');
  assert.deepEqual(create().definitions(), []);
  assert.throws(() => create().remove('tracker'), /не настроен/u);
  assert.equal(readFileSync(config, 'utf8'), original);

  create().add('tracker', settings.servers.tracker, dirname(config));
  const [restored] = await create().status();
  assert.equal(restored?.status, 'connected');
  assert.notEqual(restored, undefined);
  assert.deepEqual((restored as Record<string, unknown>).tools, [
    'mcp_tracker_list_tasks',
    'mcp_tracker_get_task',
  ]);
  assert.equal(readFileSync(config, 'utf8'), original);
});

test('MCP manager verifies strict HTTP transport and exposes only policy-approved tools over Streamable HTTP', async (t) => {
  const state = mkdtempSync(join(realpathSync(tmpdir()), 'mcp-http-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const config = join(state, 'config.json');
  writeFileSync(config, '{"servers":{}}');
  const manager = new McpManager(config, state);
  const readOnly = ['fetch_note', 'change_note'];
  const cases = [
    { url: 'http://example.org/mcp' },
    { url: 'https://username:password@example.org/mcp' },
    { url: 'https://example.org/mcp?secret=1' },
    { url: 'https://example.org/mcp#secret' },
    { url: 'file:///tmp/mcp' },
    { url: 'https://example.org/mcp', command: 'node' },
  ];
  for (const item of cases) {
    assert.throws(() => manager.add('remote', { ...item, allowReadOnly: readOnly }, state), /URL/u);
  }
  assert.deepEqual(manager.definitions(), []);

  const calls: string[] = [];
  const httpServer = createServer(async (request, response) => {
    if (request.url !== '/mcp' || request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const server = new Server(
      { name: 'local-streamable', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: 'fetch_note',
          description: 'Read the note',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'change_note',
          description: 'Change the note',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { destructiveHint: true, readOnlyHint: false },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      calls.push(request.params.name);
      return { content: [{ type: 'text', text: 'Note from actual Streamable HTTP' }] };
    });
    response.once('close', () => void server.close());
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      response.destroy(error instanceof Error ? error : undefined);
    }
  });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  t.after(() => {
    httpServer.closeAllConnections();
    httpServer.close();
  });
  const { port } = httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/mcp`;
  assert.throws(() => manager.add('remote', { url }, state), /allowReadOnly/u);
  manager.add('remote', { url, allowReadOnly: readOnly }, state);
  const [configuration] = manager.definitions();
  assert.equal(configuration?.transport, 'http');
  assert.equal(configuration?.url.href, url);

  const [status] = await manager.status();
  assert.equal(status?.status, 'connected');
  assert.deepEqual((status as Record<string, unknown>).tools, ['mcp_remote_fetch_note']);
  assert.deepEqual((status as Record<string, unknown>).denied, ['change_note']);
  const connection = await manager.connect();
  try {
    const read = connection.tools.find(({ name }) => name === 'mcp_remote_fetch_note');
    const denied = connection.tools.find(({ name }) => name === 'mcp_remote_change_note');
    assert.ok(read && denied);
    assert.equal(denied.hidden, true);
    assert.throws(() => denied.authorize?.({}), /read-only policy/u);
    const result = await read.execute({}, { maxBytes: 4096, runId: 'run', sessionId: 'session' });
    assert.deepEqual(result, { ok: true, output: ['Note from actual Streamable HTTP'] });
    assert.deepEqual(calls, ['fetch_note']);
  } finally {
    await connection.dispose();
  }
});

test('MCP registry search sends a bounded latest query and filters deleted and invalid entries', async () => {
  let requestCount = 0;
  const request: typeof fetch = async (input, init) => {
    requestCount += 1;
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://registry.modelcontextprotocol.io');
    assert.equal(url.pathname, '/v0.1/servers');
    assert.equal(url.searchParams.get('search'), 'team + notes');
    assert.equal(url.searchParams.get('limit'), '12');
    assert.equal(url.searchParams.get('version'), 'latest');
    assert.equal(init?.redirect, 'error');
    const official = 'io.modelcontextprotocol.registry/official';
    return Response.json({
      servers: [
        {
          server: {
            name: 'io.example/team-notes',
            description: 'd'.repeat(260),
            version: '1.2.3',
            remotes: [
              { type: 'streamable-http', url: 'https://notes.example/mcp' },
              { type: 'sse', url: 'https://notes.example/legacy' },
              { type: 'streamable-http', url: 5 },
            ],
          },
          _meta: { [official]: { status: 'active' } },
        },
        { server: { name: 'deleted' }, _meta: { [official]: { status: 'deleted' } } },
        { server: { description: 'Missing id' } },
        null,
      ],
    });
  };

  assert.deepEqual(await searchMcpRegistry('  team + notes  ', request), [
    {
      name: 'io.example/team-notes',
      description: 'd'.repeat(240),
      version: '1.2.3',
      urls: ['https://notes.example/mcp'],
    },
  ]);
  await assert.rejects(searchMcpRegistry(' ', request), /1 до 120/u);
  await assert.rejects(searchMcpRegistry('x'.repeat(121), request), /1 до 120/u);
  assert.equal(requestCount, 1);
  await assert.rejects(
    searchMcpRegistry('test', async () => new Response(null, { status: 503 })),
    /HTTP 503/u,
  );
});
