import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CallToolResultSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { messageOf, validators } from '../runtime/tooling.js';
import type { AgentEvent, ToolDefinition, ToolResult } from '../types.js';
import { alias, readConfig, type ServerConfig } from './config.js';

export interface McpConnection {
  tools: ToolDefinition[];
  initialEvents: Pick<AgentEvent, 'type' | 'data'>[];
  dispose(): Promise<void>;
}

type McpEvent = McpConnection['initialEvents'][number];

function blocked(
  name: string,
  source: NonNullable<ToolDefinition['source']>,
  reason: string,
): ToolDefinition {
  return {
    name,
    description: 'MCP tool unavailable under read-only policy.',
    schema: { type: 'object' },
    sideEffect: false,
    safeRetry: false,
    hidden: true,
    source,
    authorize() {
      throw new Error(reason);
    },
    async execute() {
      return { ok: false, error: reason };
    },
  };
}

async function callTool(
  client: Client,
  server: ServerConfig,
  tool: Tool,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const reply = (await client.callTool(
      { name: tool.name, arguments: args },
      CallToolResultSchema,
      { timeout: server.timeoutMs },
    )) as CallToolResult;
    const text = reply.content.flatMap((item) => (item.type === 'text' ? [item.text] : []));
    const output = reply.structuredContent ?? text;
    return reply.isError
      ? { ok: false, error: text.join('\n') || 'MCP server reported a tool error', output }
      : { ok: true, output };
  } catch (error) {
    return { ok: false, error: `MCP ${server.id}/${tool.name}: ${messageOf(error)}` };
  }
}

function exposeTool(
  client: Client,
  server: ServerConfig,
  tool: Tool,
  name: string,
): ToolDefinition {
  const source = { kind: 'mcp', server: server.id, tool: tool.name } as const;
  if (
    !server.allowReadOnly.has(tool.name) ||
    tool.annotations?.readOnlyHint !== true ||
    tool.annotations.destructiveHint === true
  ) {
    return blocked(name, source, `MCP read-only policy denied ${server.id}/${tool.name}`);
  }

  const definition: ToolDefinition = {
    name,
    description: (tool.description ?? `Read data from ${server.id}/${tool.name}.`).slice(0, 1000),
    schema: tool.inputSchema,
    sideEffect: false,
    safeRetry: true,
    source,
    execute: (args) => callTool(client, server, tool, args),
  };
  try {
    validators([definition]);
    return definition;
  } catch (error) {
    return blocked(
      name,
      source,
      `Unsupported MCP schema for ${server.id}/${tool.name}: ${messageOf(error)}`,
    );
  }
}

async function discover(client: Client, config: ServerConfig): Promise<Tool[]> {
  const tools: Tool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor }, {
      timeout: config.timeoutMs,
    });
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (cursors.has(cursor) || cursors.size >= 20)
        throw new Error('MCP tool catalog pagination limit reached');
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  return tools;
}

async function connect(config: ServerConfig): Promise<McpConnection> {
  const client = new Client({ name: 'workbench-agent', version: '0.2.0' });
  const close = () => client.close();
  const transport =
    config.transport === 'http'
      ? new StreamableHTTPClientTransport(config.url, { requestInit: { redirect: 'error' } })
      : new StdioClientTransport({
          command: config.command,
          args: config.args,
          cwd: config.cwd,
          stderr: 'ignore',
          maxBufferSize: 1024 * 1024,
          env: {
            ...Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((key) => [key, ''])),
            PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
            LANG: 'C.UTF-8',
          },
        });
  const definitions: ToolDefinition[] = [];
  const initialEvents: McpEvent[] = [];

  try {
    await client.connect(transport, { timeout: config.timeoutMs });
    const tools = await discover(client, config);
    const names = new Set<string>();
    const denied: string[] = [];
    for (const tool of tools) {
      const name = alias(config.id, tool.name);
      if (!name) {
        denied.push(tool.name);
        continue;
      }
      if (names.has(name)) throw new Error(`Duplicate MCP tool name: ${tool.name}`);
      names.add(name);
      const definition = exposeTool(client, config, tool, name);
      if (definition.hidden) denied.push(tool.name);
      definitions.push(definition);
    }
    const allowed = definitions.filter(({ hidden }) => !hidden).map(({ name }) => name);
    if (allowed.length) {
      initialEvents.push({
        type: 'mcp_connected',
        data: { server: config.id, transport: config.transport, tools: allowed, denied },
      });
    } else {
      await close();
      initialEvents.push({
        type: 'mcp_error',
        data: {
          server: config.id,
          transport: config.transport,
          error: 'No compatible tools passed the read-only policy',
          denied,
        },
      });
    }
    return { tools: definitions, initialEvents, dispose: close };
  } catch (error) {
    await close().catch(() => undefined);
    initialEvents.push({
      type: 'mcp_error',
      data: { server: config.id, transport: config.transport, error: messageOf(error) },
    });
    return { tools: [], initialEvents, dispose: close };
  }
}

export async function openMcp(configPath: string): Promise<McpConnection> {
  return openMcpConfiguration(readConfig(configPath));
}

export async function openMcpConfiguration(config: ServerConfig[]): Promise<McpConnection> {
  const servers = await Promise.all(config.map(connect));
  return {
    tools: servers.flatMap(({ tools }) => tools),
    initialEvents: servers.flatMap(({ initialEvents }) => initialEvents),
    async dispose() {
      await Promise.all(servers.map((connection) => connection.dispose()));
    },
  };
}
