import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { extendedScenarios, type EvaluationCase } from '../../eval/cases.js';
import { limits, mode, runEvaluationTrial, type TrialRow } from '../../eval/runner.js';
import { installationRoot } from '../cli/paths.js';
import type { ModelSettings } from '../model/index.js';
import type { Model } from '../types.js';
import { atomicJson } from './files.js';
import type { Market } from './index.js';
import type { InstalledVersion } from './types.js';
import { calculateDigest, compareVersions } from './validation.js';

export interface UpdateEvaluation {
  market: Market;
  candidate: InstalledVersion;
  baseline: InstalledVersion | null;
  output: string;
  model: Model & { settings?: ModelSettings };
  skillRoots?: string[];
  includeControl?: boolean;
}

export interface UpdateDecision {
  allowed: boolean;
  reason: string;
  reasons: string[];
  evidence: string;
  decisionFile: string;
  rows: TrialRow[];
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function verifyVersion(market: Market, expected: InstalledVersion): void {
  const installed = market.version(expected.name, expected.version);
  if (
    installed.digest !== expected.digest ||
    installed.root !== expected.root ||
    installed.registry !== expected.registry
  )
    throw new Error(`Version has changed: ${expected.name}@${expected.version}`);
}

function verifyPair(market: Market, baseline: InstalledVersion, candidate: InstalledVersion): void {
  if (
    candidate.name !== baseline.name ||
    candidate.registry !== baseline.registry ||
    compareVersions(candidate.version, baseline.version) <= 0
  ) {
    throw new Error('Candidate must be a newer release of the same skill and registry');
  }
  verifyVersion(market, baseline);
  verifyVersion(market, candidate);
  const active = market.active().find(({ name }) => name === baseline.name);
  if (active?.digest !== baseline.digest || active.version !== baseline.version) {
    throw new Error('Active version changed during evaluation');
  }
}

function skillDocuments(root: string): string[] {
  if (!lstatSync(root).isDirectory()) throw new Error('Skill root is not a regular directory');
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, 'SKILL.md'))
    .filter((document) => {
      try {
        return lstatSync(document).isFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });
}

function freezeSources(scenarios: EvaluationCase[], roots: string[]): [string, string][] {
  const localFiles = [
    'config/mcp.json',
    'eval/cases.ts',
    'eval/runner.ts',
    'eval/scoring.ts',
    'eval/fixtures/policy.json',
    'package-lock.json',
    ...scenarios.flatMap(({ id, source }) => (source ? [`eval/fixtures/${id}/${source}`] : [])),
  ].map((path) => join(installationRoot, path));
  const sourceDirectories = [
    'eval/checks',
    'src/mcp',
    'src/model',
    'src/runtime',
    'src/skills',
    'src/workspace',
  ];
  for (const relativeDir of sourceDirectories) {
    const directory = join(installationRoot, relativeDir);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile()) localFiles.push(join(directory, entry.name));
    }
  }
  return [...new Set([...localFiles, ...roots.flatMap(skillDocuments)])]
    .sort()
    .map((file) => [relative(installationRoot, file), calculateDigest(readFileSync(file))]);
}

function selectCases(name: string, includeControl: boolean): EvaluationCase[] {
  const cases = extendedScenarios.filter(({ expectedSkill }) => expectedSkill === name);
  if (cases.length < 2) throw new Error(`At least two evaluation cases must cover ${name}`);
  const control = includeControl
    ? extendedScenarios.find(({ id }) => id === 'no-skill')
    : undefined;
  return control ? [...cases, control] : cases;
}

function completeTrial(row: TrialRow | undefined): boolean {
  return Boolean(
    row?.run_id && row.session_id && row.status === 'completed' && row.journal && !row.error,
  );
}

function compareResults(cases: EvaluationCase[], rows: TrialRow[]): string[] {
  const problems: string[] = [];
  if (
    rows.length !== cases.length * 2 ||
    new Set(rows.map(({ run_id }) => run_id)).size !== rows.length ||
    new Set(rows.map(({ session_id }) => session_id)).size !== rows.length
  ) {
    problems.push('Evaluation run coverage or identities are incomplete');
  }
  for (const { id } of cases) {
    const old = rows.find((row) => row.case_id === id && row.variant === 'A');
    const next = rows.find((row) => row.case_id === id && row.variant === 'B');
    if (!completeTrial(old)) problems.push(`${id}: baseline did not complete with evidence`);
    if (!completeTrial(next)) {
      problems.push(`${id}: candidate did not complete with evidence`);
      continue;
    }
    if (
      !next?.outcome_pass ||
      !next.tool_pass ||
      next.routing_pass_or_na !== true ||
      !next.trial_pass
    ) {
      problems.push(`${id}: candidate failed required artifact, tools or routing checks`);
    }
    if (old?.trial_pass && !next?.trial_pass)
      problems.push(`${id}: regression against active version`);
  }
  return problems;
}

function prepareDirectory(path: string): string {
  const directory = resolve(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || readdirSync(directory).length) {
    throw new Error('Evaluation output requires an empty directory');
  }
  return realpathSync(directory);
}

export async function evaluateUpdate(options: UpdateEvaluation): Promise<UpdateDecision> {
  const { market, baseline, candidate, model } = options;
  const evidence = prepareDirectory(options.output);
  const decisionFile = join(evidence, 'decision.json');
  const rows: TrialRow[] = [];
  const startedAt = new Date().toISOString();
  let reasons: string[];
  try {
    if (!baseline) throw new Error('No active baseline to evaluate against');
    verifyPair(market, baseline, candidate);
    const scenarios = selectCases(candidate.name, options.includeControl === true);
    const sharedRoots = options.skillRoots ?? [join(installationRoot, 'skills')];
    const oldRoots = [baseline.root, ...sharedRoots];
    const candidateRoots = [candidate.root, ...sharedRoots];
    const usedRoots = [...new Set([...oldRoots, ...candidateRoots])];
    const snapshots = freezeSources(scenarios, usedRoots);
    atomicJson(join(evidence, 'manifest.json'), {
      schema: 1,
      startedAt,
      baseline,
      candidate,
      mode,
      limits,
      model: model.settings ?? null,
      scenarios: scenarios.map(({ id, prompt, source, artifact, expectedSkill }) => ({
        id,
        prompt,
        source: source ?? null,
        artifact,
        expectedSkill,
      })),
      sourceDigests: Object.fromEntries(snapshots),
    });
    for (const scenario of scenarios) {
      for (const variant of ['A', 'B'] as const) {
        const skillDirectories = variant === 'A' ? oldRoots : candidateRoots;
        rows.push(
          await runEvaluationTrial(
            { scenario, variant, trial: 1, skillDirectories, routingVariant: 'B' },
            evidence,
            model,
          ),
        );
      }
    }
    verifyPair(market, baseline, candidate);
    if (JSON.stringify(snapshots) !== JSON.stringify(freezeSources(scenarios, usedRoots))) {
      throw new Error('Evaluation inputs changed while it was running');
    }
    reasons = compareResults(scenarios, rows);
  } catch (error) {
    reasons = [reasonOf(error)];
  }
  const allowed = reasons.length === 0;
  const reason = allowed
    ? 'Candidate passed all required checks against the active version'
    : reasons.join('; ');
  const result = { allowed, reason, reasons, evidence, decisionFile, rows };
  atomicJson(decisionFile, {
    schema: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    baseline,
    candidate,
    ...result,
  });
  return result;
}
