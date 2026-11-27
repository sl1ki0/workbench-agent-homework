import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const optionSchema = {
  help: { type: 'boolean', short: 'h', default: false },
  workspace: { type: 'string', default: 'workspace' },
  policy: { type: 'string', default: 'config/policy.json' },
  'state-dir': { type: 'string', default: '.agent' },
  session: { type: 'string' },
  mode: { type: 'string', default: 'safe' },
  plan: { type: 'boolean', default: false },
  decision: { type: 'string' },
  attribute: { type: 'string' },
  'model-calls': { type: 'string' },
  'tool-calls': { type: 'string' },
  'side-effects': { type: 'string' },
  'result-bytes': { type: 'string' },
  'no-color': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
} as const;

type LimitName = 'modelCalls' | 'toolCalls' | 'sideEffects' | 'resultBytes';
export type Decision = 'approve' | 'deny' | 'retry' | 'skip' | 'abort';

const decisions: Decision[] = ['approve', 'deny', 'retry', 'skip', 'abort'];

export function parseDecision(value: string): Decision {
  const accepted = decisions.find((candidate) => candidate === value);
  if (!accepted) throw new Error(`Допустимые решения: ${decisions.join(', ')}`);
  return accepted;
}

export function parseAttribution(value: string): boolean {
  if (value === 'yes') return true;
  if (value === 'no') return false;
  throw new Error('Для указания автора изменений выберите yes или no');
}

function parseMode(value: string): 'safe' | 'auto' {
  if (value !== 'safe' && value !== 'auto') throw new Error('--mode принимает safe или auto');
  return value;
}

function parseLimit(raw: string | undefined, key: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value)) {
    throw new Error(`--${key} принимает целое неотрицательное число`);
  }
  return value;
}

export function parseOptions(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: optionSchema,
    allowPositionals: true,
  });
  const [command = 'chat', ...rest] = positionals;

  const limits: Partial<Record<LimitName, number>> = {};
  const names = {
    'model-calls': 'modelCalls',
    'tool-calls': 'toolCalls',
    'side-effects': 'sideEffects',
    'result-bytes': 'resultBytes',
  } as const;
  for (const [option, key] of Object.entries(names)) {
    const limit = parseLimit(values[option as keyof typeof names], option);
    if (limit !== undefined) limits[key] = limit;
  }

  return {
    command,
    rest,
    mode: parseMode(values.mode),
    limits,
    workspace: resolve(values.workspace),
    policy: resolve(values.policy),
    stateDir: resolve(values['state-dir']),
    session: values.session,
    plan: values.plan,
    decision: values.decision ? parseDecision(values.decision) : undefined,
    attribute: values.attribute === undefined ? undefined : parseAttribution(values.attribute),
    noColor: values['no-color'],
    json: values.json,
    help: values.help || command === 'help',
  };
}

export type CliOptions = ReturnType<typeof parseOptions>;
