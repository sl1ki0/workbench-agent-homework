import type { ToolDefinition } from '../types.js';
import type { Plan, Run, Task } from './types.js';

const text = { type: 'string', minLength: 1, maxLength: 1000 };
const textList = { type: 'array', items: text, maxItems: 30 };
const identifier = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}$' };

export const planSchema = {
  type: 'object',
  required: ['goal', 'steps', 'risks', 'assumptions', 'doneCriteria'],
  additionalProperties: false,
  properties: {
    goal: text,
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        required: ['id', 'description', 'dependsOn', 'tools', 'verification'],
        additionalProperties: false,
        properties: {
          id: identifier,
          description: text,
          dependsOn: { type: 'array', items: identifier, uniqueItems: true },
          tools: { ...textList, minItems: 1, uniqueItems: true },
          verification: text,
        },
      },
    },
    risks: textList,
    assumptions: textList,
    doneCriteria: text,
  },
};

export function validatePlan(plan: Plan, tools: ReadonlyMap<string, ToolDefinition>): void {
  const remaining = new Map(plan.steps.map((step) => [step.id, step]));
  if (remaining.size !== plan.steps.length) throw new Error('Plan has duplicate task IDs');
  for (const step of plan.steps) {
    for (const name of step.tools) {
      if (!tools.has(name)) throw new Error(`Unknown tool in task ${step.id}: ${name}`);
    }
  }
  const checked = new Set<string>();
  while (remaining.size) {
    const next = [...remaining.values()].find((step) =>
      step.dependsOn.every((id) => checked.has(id)),
    );
    if (!next) throw new Error('Plan has missing or cyclic dependencies');
    remaining.delete(next.id);
    checked.add(next.id);
  }
}

export function activeTask(run: Run): Task | undefined {
  return run.tasks.find((task) => task.status === 'running');
}

export function startNextTask(run: Run): Task | undefined {
  const done = new Set(
    run.tasks.filter((task) => task.status === 'completed').map((task) => task.id),
  );
  const next = run.tasks.find(
    (task) => task.status === 'pending' && task.dependsOn.every((id) => done.has(id)),
  );
  if (next) next.status = 'running';
  return next;
}

export function recordTaskEvidence(run: Run, id: string): Task {
  const task = activeTask(run);
  if (!task) throw new Error('There is no active task');
  const records = run.records.filter((record) => record.taskId === task.id);
  const index = records.findLastIndex((record) => record.call.id === id && !record.replayed);
  const evidence = records[index];
  if (!evidence?.result.ok || evidence.result.truncated || evidence.result.output === undefined) {
    throw new Error('Evidence must be a successful tool result from this task');
  }
  const name = evidence.call.function.name;
  const lastMutation = records.findLastIndex((record) => Boolean(record.changes?.length));
  if (!task.tools.includes(name))
    throw new Error('Evidence must use a tool listed in the approved task');
  if (index < lastMutation) throw new Error('Evidence must follow the most recent project change');
  if (['list_files', 'read_file', 'Bash'].includes(name)) {
    if (lastMutation !== -1 && name === 'list_files') {
      throw new Error('Verify changed files by reading them or running an approved test command');
    }
    if (lastMutation !== -1 && name === 'read_file') {
      const changed = new Set(
        records.flatMap((record) => record.changes?.map((file) => file.path) ?? []),
      );
      if (!changed.has(String(evidence.args?.path)))
        throw new Error('Read a file changed by this task');
    }
  } else {
    throw new Error('Use a project read, listing, or approved test result as evidence');
  }
  task.evidence = evidence.result;
  task.evidenceCallId = id;
  task.status = 'completed';
  return task;
}
