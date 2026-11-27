export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
}

export type Message =
  | { role: 'system' | 'user'; content: string }
  | AssistantMessage
  | { role: 'tool'; tool_call_id: string; content: string };

export interface Usage {
  input?: number;
  output?: number;
  cached?: number;
  reasoning?: number;
}

export interface ModelReply {
  message: AssistantMessage;
  usage?: Usage;
}

export interface Model {
  complete(messages: Message[], tools: ToolDefinition[]): Promise<ModelReply>;
}

export interface ToolContext {
  maxBytes: number;
  runId: string;
  sessionId: string;
}

export interface ToolResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  truncated?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  sideEffect: boolean;
  safeRetry: boolean;
  authorize?(args: Record<string, unknown>): void;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  source?: { kind: 'skill' } | { kind: 'mcp'; server: string; tool: string };
}

export interface AgentEvent {
  id: string;
  time: string;
  session_id: string;
  run_id: string;
  type: string;
  data: Record<string, unknown>;
}
