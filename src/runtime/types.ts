import type {
  AgentEvent,
  Message,
  Model,
  ToolCall,
  ToolDefinition,
  ToolResult,
  Usage,
} from '../types.js';
import type { FileChange, Snapshot, Workspace } from '../workspace/index.js';

export interface Limits {
  modelCalls: number;
  toolCalls: number;
  sideEffects: number;
  resultBytes: number;
}

export type RunStatus =
  | 'running'
  | 'awaiting_confirmation'
  | 'awaiting_plan'
  | 'uncertain'
  | 'completed'
  | 'failed'
  | 'budget_exhausted';

export type Decision = 'approve' | 'deny' | 'retry' | 'skip' | 'abort';
export type Phase = 'planning' | 'execution';

export interface PlanStep {
  id: string;
  description: string;
  dependsOn: string[];
  tools: string[];
  verification: string;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  risks: string[];
  assumptions: string[];
  doneCriteria: string;
}

export interface Task extends PlanStep {
  status: 'pending' | 'running' | 'completed';
  evidenceCallId?: string;
  evidence?: ToolResult;
}

export interface UsageTotal {
  total: number | null;
  known: number;
  requests: number;
  status: 'complete' | 'partial' | 'unknown';
}

export type UsageSummary = Record<keyof Usage, UsageTotal>;

export interface CallRecord {
  call: ToolCall;
  args?: Record<string, unknown>;
  phase: Phase;
  taskId?: string;
  attempt: number;
  result: ToolResult;
  changes?: FileChange[];
  replayed?: boolean;
}

export interface PendingAction {
  call: ToolCall;
  args: Record<string, unknown>;
  phase: Phase;
  taskId?: string;
  attempt: number;
  stage: 'confirmation' | 'started';
  before?: Snapshot;
  changes?: FileChange[];
}

export interface Run {
  id: string;
  sessionId: string;
  workspace: string;
  createdAt: string;
  status: RunStatus;
  mode: 'safe' | 'auto';
  phase: Phase;
  messages: Message[];
  batch: ToolCall[];
  records: CallRecord[];
  limits: Limits;
  spent: Limits;
  usageSamples: Usage[];
  usage: UsageSummary;
  baseline: Snapshot;
  changes: FileChange[];
  pending?: PendingAction;
  plan?: Plan;
  tasks: Task[];
  error?: string;
  final?: string;
  rolledBack?: boolean;
  events: AgentEvent[];
}

export interface AgentOptions {
  workspace: Workspace;
  stateDir: string;
  model: Model;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  onEvent?: (event: AgentEvent) => void;
  initialEvents?: Pick<AgentEvent, 'type' | 'data'>[];
  afterExecute?: (details: {
    call: ToolCall;
    result: ToolResult;
    run: Run;
  }) => void | Promise<void>;
}

export interface StartOptions {
  prompt: string;
  sessionId?: string;
  mode?: 'safe' | 'auto';
  plan?: boolean;
  limits?: Partial<Limits>;
}

export interface SessionStats {
  sessionId: string;
  runs: number;
  requests: number;
  usage: UsageSummary;
  tools: Record<string, number>;
  skills: Record<string, number>;
  mcp: Record<string, number>;
  uniqueTools: number;
  uniqueSkills: number;
}
