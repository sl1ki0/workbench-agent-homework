import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import tasks from './tasks.json' with { type: 'json' };

const statuses = ['open', 'closed', 'all'];
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const tools: Tool[] = [
  {
    name: 'list_tasks',
    description:
      'List tasks in the frozen educational tracker. Filter by status or omit the filter for all tasks.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: statuses } },
      additionalProperties: false,
    },
    annotations,
  },
  {
    name: 'get_task',
    description: 'Read one task by its ID in the frozen educational tracker.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^T[0-9]{1,3}$' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations,
  },
];

function output(value: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: value,
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

const server = new Server(
  { name: 'educational-tracker', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const args = params.arguments ?? {};
  if (params.name === 'list_tasks') {
    const status = Object.hasOwn(args, 'status') ? args.status : 'all';
    if (
      Object.keys(args).some((key) => key !== 'status') ||
      typeof status !== 'string' ||
      !statuses.includes(status)
    ) {
      return failure('Expected only status=open, status=closed or status=all');
    }
    const selected = status === 'all' ? tasks : tasks.filter((task) => task.status === status);
    return output({ tasks: selected, count: selected.length });
  }
  if (params.name === 'get_task') {
    if (
      Object.keys(args).length !== 1 ||
      typeof args.id !== 'string' ||
      !/^T[0-9]{1,3}$/.test(args.id)
    ) {
      return failure('Expected one tracker ID, such as T1');
    }
    const task = tasks.find(({ id }) => id === args.id);
    return task ? output({ task }) : failure(`Task ${args.id} was not found`);
  }
  return failure('Tool unavailable in this read-only tracker');
});

await server.connect(new StdioServerTransport());
