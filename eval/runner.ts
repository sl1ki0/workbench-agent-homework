import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openMcp } from '../src/mcp/index.js';
import { makeModel, type ModelSettings } from '../src/model/index.js';
import {
  Agent,
  type Limits,
  type Run,
  type RunStatus,
  type SessionStats,
} from '../src/runtime/index.js';
import { loadSkills } from '../src/skills/index.js';
import type { Model } from '../src/types.js';
import { readPolicy, Workspace } from '../src/workspace/index.js';
import { scenarios, type EvaluationCase } from './cases.js';
import type { Check } from './checks/markdown.js';
import { checkRouting, checkTools, type Variant } from './scoring.js';

export const trialsPerVariant = 3;
export const mode = 'auto';
export const limits: Limits = {
  modelCalls: 12,
  toolCalls: 24,
  sideEffects: 8,
  resultBytes: 64_000,
};
const fixtureDirectory = 'eval/fixtures';
const policyFile = `${fixtureDirectory}/policy.json`;
const mcpFile = 'config/mcp.json';
const skillRoots = ['skills'];
const variants: Variant[] = ['A', 'B'];

interface TrialSpec {
  scenario: EvaluationCase;
  variant: Variant;
  trial: number;
}

type EvaluationModel = Model & { settings: ModelSettings };

export interface TrialRow {
  case_id: string;
  variant: Variant;
  trial: number;
  run_id: string | null;
  session_id: string;
  status: RunStatus | 'infrastructure_error';
  outcome_pass: boolean;
  routing_pass_or_na: boolean | 'n/a';
  tool_pass: boolean;
  trial_pass: boolean;
  input_tokens: number | null;
  output_tokens: number | null;
  usage: Run['usage'] | null;
  skill_activations: Record<string, number>;
  tool_calls: Record<string, number>;
  mcp_calls: Record<string, number>;
  error: string | null;
  duration_ms: number;
  artifact: string | null;
  journal: string | null;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, undefined, 2)}\n`);
}

function jsonLine(data: unknown): string {
  return `${JSON.stringify(data)}\n`;
}

function cleanText(value: string, scratch: string): string {
  return value.replaceAll(process.cwd(), '<repo>').replaceAll(scratch, '<trial>');
}

function infrastructureError(error: unknown, scratch: string): string {
  return cleanText(error instanceof Error ? error.message : String(error), scratch);
}

function inspectOutcome(
  scenario: EvaluationCase,
  workspace: Workspace,
): { content?: Buffer; check: Check } {
  const files = workspace.snapshot();
  const extra = Object.keys(files).filter(
    (path) => path !== scenario.artifact && path !== scenario.source,
  );
  const concerns = extra.length ? [`Лишние файлы: ${extra.join(', ')}.`] : [];
  if (scenario.source) {
    const original = readFileSync(join(fixtureDirectory, scenario.id, scenario.source));
    const actual = files[scenario.source];
    if (!actual || !Buffer.from(actual.content, 'base64').equals(original))
      concerns.push('Исходный файл изменён или удалён.');
  }
  const artifact = files[scenario.artifact];
  if (!artifact)
    return { check: { pass: false, details: [...concerns, 'Файл результата отсутствует.'] } };
  const content = Buffer.from(artifact.content, 'base64');
  const result = scenario.check(content);
  return {
    content,
    check: {
      pass: result.pass && concerns.length === 0,
      details: [...concerns, ...result.details],
    },
  };
}

async function runTrial(spec: TrialSpec, output: string, model: Model): Promise<TrialRow> {
  const { scenario, variant, trial } = spec;
  const directory = join(output, 'trials', scenario.id, `${variant}${trial}`);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'workbench-eval-')));
  const workspaceRoot = join(scratch, 'workspace');
  const stateDir = join(scratch, 'state');
  const sessionId = randomUUID();
  const start = performance.now();
  let runId: string | undefined;
  let agent: Agent | undefined;
  let run: Run | undefined;
  let stats: SessionStats | undefined;
  let error: string | null = null;
  let outcome: ReturnType<typeof inspectOutcome> = {
    check: { pass: false, details: ['Агент не запущен.'] },
  };

  try {
    mkdirSync(workspaceRoot);
    mkdirSync(directory, { recursive: true });
    if (scenario.source)
      copyFileSync(
        join(fixtureDirectory, scenario.id, scenario.source),
        join(workspaceRoot, scenario.source),
      );
    const workspace = new Workspace(workspaceRoot, readPolicy(policyFile));
    const skills = variant === 'B' ? loadSkills(skillRoots) : undefined;
    const mcp = await openMcp(mcpFile);
    try {
      agent = new Agent({
        workspace,
        stateDir,
        model,
        tools: [...mcp.tools, ...(skills?.tools ?? [])],
        systemPrompt: skills?.systemPrompt,
        initialEvents: [...mcp.initialEvents, ...(skills?.initialEvents ?? [])],
        onEvent: (event) => {
          if (event.type === 'run_started') runId = event.run_id;
        },
      });
      try {
        run = await agent.start({ prompt: scenario.prompt, sessionId, mode, limits });
      } catch (failure) {
        error = infrastructureError(failure, scratch);
        if (runId) run = agent.get(runId);
      }
      stats = agent.stats(sessionId);
      outcome = inspectOutcome(scenario, workspace);
    } finally {
      await mcp.dispose();
    }
  } catch (failure) {
    error ??= infrastructureError(failure, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  let artifact: string | null = null;
  let journal: string | null = null;
  if (outcome.content) {
    const path = join(directory, scenario.artifact);
    writeFileSync(path, outcome.content);
    artifact = relative(output, path);
  }
  if (run) {
    const path = join(directory, 'events.jsonl');
    const events = run.events.map((event) => jsonLine(event)).join('');
    writeFileSync(path, cleanText(events, scratch));
    journal = relative(output, path);
  }
  const routing = checkRouting(scenario, variant, run?.events ?? []);
  const tools = checkTools(scenario, run?.events ?? [], run?.records ?? []);
  if (run?.error) error ??= cleanText(run.error, scratch);
  if (run && run.status !== 'completed') error ??= `Агент остановился со статусом ${run.status}.`;
  const row: TrialRow = {
    case_id: scenario.id,
    variant,
    trial,
    session_id: sessionId,
    run_id: run?.id ?? null,
    status: run?.status ?? 'infrastructure_error',
    outcome_pass: outcome.check.pass,
    routing_pass_or_na: routing === 'n/a' ? routing : routing.pass,
    tool_pass: tools.pass,
    trial_pass:
      run?.status === 'completed' &&
      !error &&
      tools.pass &&
      outcome.check.pass &&
      (routing === 'n/a' || routing.pass),
    input_tokens: run?.usage.input.total ?? null,
    output_tokens: run?.usage.output.total ?? null,
    usage: run?.usage ?? null,
    skill_activations: stats?.skills ?? {},
    tool_calls: stats?.tools ?? {},
    mcp_calls: stats?.mcp ?? {},
    error,
    duration_ms: Math.round(performance.now() - start),
    artifact,
    journal,
  };
  mkdirSync(directory, { recursive: true });
  writeJson(join(directory, 'result.json'), {
    ...row,
    spent: run?.spent ?? null,
    outcome_checks: outcome.check.details,
    routing_checks: routing === 'n/a' ? routing : routing.details,
    tool_checks: tools.details,
  });
  appendFileSync(join(output, 'trials.jsonl'), jsonLine(row));
  return row;
}

function frozenFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .flatMap((item) => {
      const child = join(root, item.name);
      return item.isDirectory() ? frozenFiles(child) : item.isFile() ? [child] : [];
    });
}

function checksums(): Record<string, string> {
  const evalFiles = readdirSync('eval')
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join('eval', name));
  const paths = [
    'package-lock.json',
    'docs/evaluation-protocol.md',
    mcpFile,
    ...(existsSync('config/Modelfile.eval') ? ['config/Modelfile.eval'] : []),
    'src/types.ts',
    ...['mcp', 'model', 'runtime', 'skills', 'workspace'].flatMap((part) =>
      frozenFiles(join('src', part)),
    ),
    ...frozenFiles('eval/checks'),
    ...frozenFiles(fixtureDirectory),
    ...skillRoots.flatMap((root) => frozenFiles(root)),
    ...evalFiles,
  ];
  return Object.fromEntries(
    paths
      .sort()
      .map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
  );
}

export async function executeTrials(
  output: string,
  smoke?: Pick<TrialSpec, 'scenario' | 'variant'>,
  testAdapter?: EvaluationModel,
): Promise<void> {
  const model = testAdapter ?? makeModel();
  mkdirSync(output, { recursive: true });
  if (readdirSync(output).length)
    throw new Error('Каталог eval уже содержит результаты. Укажите новый каталог.');
  const queue = smoke
    ? [{ ...smoke, trial: 1 }]
    : scenarios.flatMap((scenario) =>
        Array.from({ length: trialsPerVariant }, (_, i) =>
          variants.map((variant) => ({ scenario, variant, trial: i + 1 })),
        ).flat(),
      );
  const files = checksums();
  writeJson(join(output, 'manifest.json'), {
    created_at: new Date().toISOString(),
    experiment: testAdapter ? 'mock' : smoke ? 'smoke' : 'A/B',
    node: process.version,
    model: model.settings,
    mode,
    limits,
    mcp: mcpFile,
    policy: policyFile,
    configurations: { A: { skills: false }, B: { skills: true, directories: skillRoots } },
    scenarios: scenarios.map(
      ({ id, prompt, source, artifact, expectedSkill, allowedTools, requiredCalls }) => ({
        id,
        prompt,
        source,
        artifact,
        expectedSkill,
        allowedTools,
        requiredCalls,
      }),
    ),
    order: queue.map(({ scenario, variant, trial }) => [scenario.id, variant, trial]),
    files_sha256: files,
  });
  for (const spec of queue) {
    const row = await runTrial(spec, output, model);
    process.stdout.write(
      `${row.case_id} ${row.variant}${row.trial} · ${row.status} · outcome=${row.outcome_pass} · routing=${row.routing_pass_or_na} · ${row.run_id ?? 'без run_id'}\n`,
    );
  }
  const after = checksums();
  if (JSON.stringify(after) !== JSON.stringify(files)) {
    throw new Error(
      'Исходные данные или конфигурация изменились во время эксперимента. Материалы сохранены.',
    );
  }
  writeJson(join(output, 'completion.json'), {
    checked_at: new Date().toISOString(),
    frozen_files_verified: true,
  });
}
