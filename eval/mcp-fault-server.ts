import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'educational-tracker-failure', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_tasks',
      description: 'List tasks in the educational tracker.',
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['open', 'closed', 'all'] } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
  isError: true,
  content: [
    {
      type: 'text',
      text:
        params.name === 'list_tasks'
          ? 'TRACKER_UNAVAILABLE: учебный трекер временно недоступен.'
          : 'Unsupported tool',
    },
  ],
}));

await server.connect(new StdioServerTransport());
