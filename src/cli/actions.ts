import type { Agent } from '../runtime/index.js';
import type { CliRun } from './format.js';
import type { CliOptions, Decision } from './options.js';

export function required(value: string | undefined, help: string): string {
  if (!value) throw new Error(help);
  return value;
}

export function isPending(run: CliRun): boolean {
  return ['awaiting_confirmation', 'awaiting_plan', 'uncertain'].includes(run.status);
}

export function pendingHelp(run: CliRun): string {
  if (run.status !== 'uncertain') return 'Нужно решение · /approve · /deny';
  return run.pending?.changes?.length
    ? 'Укажите принадлежность изменений · /retry yes|no · /skip yes|no · /abort yes|no'
    : 'Нужно решение · /retry · /skip · /abort';
}

export function startArgs(prompt: string, options: CliOptions, sessionId = options.session) {
  return { prompt, mode: options.mode, plan: options.plan, limits: options.limits, sessionId };
}

export function resumeRun(agent: Agent, id: string, decision?: Decision, attribute?: boolean) {
  return agent.resume(
    id,
    decision,
    attribute === undefined ? undefined : { attributeChanges: attribute },
  );
}
