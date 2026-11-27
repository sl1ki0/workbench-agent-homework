import assert from 'node:assert/strict';
import { cpSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { evaluationOperations } from '../src/cli/eval-operations.js';
import {
  marketOperations,
  openProjectMarket,
  projectMarketTools,
  runMarketChecks,
  startMarketWatcher,
} from '../src/cli/market-commands.js';
import { Agent } from '../src/runtime/index.js';
import { readPolicy, Workspace } from '../src/workspace/index.js';
import type { ModelReply } from '../src/types.js';
import { changeSkillSelection, projectSkills } from '../src/cli/project-skills.js';
import { parseOptions } from '../src/cli/options.js';

function project(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'workbench-services-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return parseOptions(['--state-dir', join(root, 'state')], workspace);
}

test('market service searches, explicitly installs a baseline and blocks install as update bypass', async (t) => {
  const options = project(t);
  const market = marketOperations(options);
  const catalog = await market.search({ query: '' });
  assert.ok(Array.isArray(catalog) && catalog.length >= 3);
  const installed = await market.install({ name: 'progress-summary', version: '1.0.0' });
  assert.equal(
    installed && typeof installed === 'object' && 'version' in installed && installed.version,
    '1.0.0',
  );
  await assert.rejects(
    async () => market.install({ name: 'progress-summary', version: '1.1.0' }),
    /используйте update/u,
  );
  const active = openProjectMarket(options).active();
  assert.deepEqual(
    active.map(({ name, version }) => [name, version]),
    [['progress-summary', '1.0.0']],
  );
  const updates = await openProjectMarket(options).updates();
  assert.equal(updates[0]?.candidate.version, '2.0.0');
});

test('auto updates are disabled by default and the watcher leaves a disabled registry idle', async (t) => {
  const options = project(t);
  const market = marketOperations(options);
  const status = JSON.stringify(market.auto({ action: 'status' }));
  assert.match(status, /"pollingEnabled":false/u);
  assert.match(status, /"autoEnabled":false/u);
  const notifications: string[] = [];
  const stop = startMarketWatcher(
    { ...options, marketConfig: join(options.stateDir, 'missing-config.json') },
    (message) => notifications.push(message),
  );
  t.after(stop);
  await new Promise<void>((done) => setImmediate(done));
  assert.deepEqual(notifications, []);
  assert.throws(() => market.auto({ action: 'on', intervalMinutes: 0 }), /Интервал/u);
  assert.match(
    JSON.stringify(market.auto({ action: 'on', intervalMinutes: 15 })),
    /"enabled":true/u,
  );
  assert.match(JSON.stringify(market.auto({ action: 'off' })), /"enabled":false/u);
});

test('polling detects a new skill and version once, independently of auto-update, and preserves the last good copy', async (t) => {
  const options = project(t);
  const registryRoot = join(options.stateDir, 'registry');
  mkdirSync(registryRoot, { recursive: true });
  cpSync('market-fixtures/skills', join(registryRoot, 'skills'), { recursive: true });
  const index = join(registryRoot, 'index.json');
  const setManifest = (version: string) =>
    copyFileSync(`market-fixtures/index-${version}.json`, index);
  setManifest('baseline');
  const marketConfig = join(registryRoot, 'config.json');
  writeFileSync(
    marketConfig,
    JSON.stringify({ registries: [{ id: 'demo', index: 'index.json' }] }),
  );
  const configured = { ...options, marketConfig };
  const market = marketOperations(configured);
  await market.install({ name: 'progress-summary', version: '1.0.0' });
  market.auto({ action: 'configure', registry: 'demo', pollingEnabled: true });
  const baseline = await runMarketChecks(configured, false);
  assert.equal(baseline.checks.length, 1);
  assert.deepEqual(baseline.checks[0]?.newSkills, []);
  assert.deepEqual(baseline.updates, []);

  setManifest('stable');
  market.auto({ action: 'configure', registry: 'demo', pollingEnabled: true });
  let stop: () => void = () => {};
  let deadline: NodeJS.Timeout | undefined;
  const notice = await new Promise<string>((resolve, reject) => {
    deadline = setTimeout(() => reject(new Error('Automatic market notification timed out')), 2000);
    stop = startMarketWatcher(configured, resolve);
  }).finally(() => {
    clearTimeout(deadline);
    stop();
  });
  assert.match(notice, /Новый скилл · study-note-checklist@1\.0\.0/u);
  assert.match(notice, /Обновление скилла · progress-summary · 1\.0\.0 → 1\.1\.0/u);
  const unchanged = await runMarketChecks(configured, true);
  assert.deepEqual(unchanged.checks[0]?.newSkills, []);
  assert.deepEqual(unchanged.checks[0]?.newVersions, []);
  assert.equal(openProjectMarket(configured).active()[0]?.version, '1.0.0');

  market.auto({ action: 'configure', registry: 'demo', autoEnabled: true });
  const testGate = async (_options: typeof options, engine: ReturnType<typeof openProjectMarket>) =>
    engine.reconcile(async () => true, 'demo');
  const updated = await runMarketChecks(configured, false, 'demo', testGate);
  assert.equal(updated.updates[0]?.status, 'activated');
  assert.equal(openProjectMarket(configured).active()[0]?.version, '1.1.0');
  const repeated = await runMarketChecks(configured, true, 'demo', testGate);
  assert.deepEqual(repeated.updates, []);
  setManifest('invalid');
  const invalid = await runMarketChecks(configured, true, 'demo', testGate);
  assert.equal(invalid.updates[0]?.status, 'failed');
  assert.match(invalid.updates[0]?.error ?? '', /SHA-256/u);
  assert.equal(openProjectMarket(configured).active()[0]?.version, '1.1.0');
  rmSync(index);
  const offline = await runMarketChecks(configured, true, 'demo', testGate);
  assert.ok(offline.checks[0]?.error);
  assert.equal(openProjectMarket(configured).active()[0]?.version, '1.1.0');
  assert.ok(
    openProjectMarket(configured)
      .events()
      .some(
        (event) => event.type === 'market_version_discovered' && event.old?.version === '1.0.0',
      ),
  );
});

test('market tools offer a new skill by topic and only install the exact digest', async (t) => {
  const options = project(t);
  const [search, install] = projectMarketTools(options, ['progress-summary']);
  assert.ok(search && install);
  const context = { maxBytes: 10_000, runId: 'market-test', sessionId: 'market-test' };
  assert.equal(search.sideEffect, false);
  assert.equal(install.sideEffect, true);
  assert.throws(() => install.authorize?.({ name: 'progress-summary' }), /already present/u);
  const result = await search.execute({ query: 'study note' }, context);
  assert.ok(Array.isArray(result.output));
  const first = result.output[0] as Record<string, unknown>;
  assert.equal(first.name, 'study-note-checklist');
  const { name, version, registry, digest } = first;
  await assert.rejects(
    install.execute({ name, version, registry, digest: '0'.repeat(64) }, context),
    /exact skill revision/u,
  );
  assert.deepEqual(openProjectMarket(options).active(), []);
  await assert.rejects(
    install.execute({ name, version, registry, digest }, context),
    /one marketplace skill per run/u,
  );
  const installed = await install.execute(
    { name, version, registry, digest },
    { ...context, runId: 'market-next-run' },
  );
  assert.equal(installed.ok, true);
  assert.equal(openProjectMarket(options).active()[0]?.name, 'study-note-checklist');
  await assert.rejects(
    install.execute({ name, version, registry, digest }, context),
    /already available/u,
  );
});

test('market install honors safe-mode approval and updates the catalog used by the next run', async (t) => {
  const options = project(t);
  const known = projectSkills(options);
  assert.ok(known);
  const calls = (id: string, name: string, args: Record<string, unknown>): ModelReply => ({
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    },
  });
  const agent = new Agent({
    workspace: new Workspace(options.workspace, readPolicy(options.policy)),
    stateDir: options.stateDir,
    tools: [
      ...known.tools,
      ...projectMarketTools(
        options,
        known.catalog.map(({ name }) => name),
      ),
    ],
    systemPrompt: known.systemPrompt,
    model: {
      async complete(messages) {
        const last = messages.at(-1);
        if (last?.role !== 'tool')
          return calls('market-search', 'search_market_skills', { query: 'study note' });
        if (last.tool_call_id === 'market-search') {
          const release = (JSON.parse(last.content) as { output: Record<string, unknown>[] })
            .output[0];
          assert.equal(release?.name, 'study-note-checklist');
          const { name, version, registry, digest } = release!;
          return calls('market-install', 'install_market_skill', {
            name,
            version,
            registry,
            digest,
          });
        }
        assert.match(last.content, /next run/u);
        return {
          message: { role: 'assistant', content: 'The skill is available in the next run.' },
        };
      },
    },
  });
  const pending = await agent.start({
    prompt: 'Find and install a study-note checklist skill.',
    mode: 'safe',
  });
  assert.equal(pending.status, 'awaiting_confirmation');
  assert.deepEqual(openProjectMarket(options).active(), []);
  const done = await agent.resume(pending.id, 'approve');
  assert.equal(done.status, 'completed');
  assert.match(done.final ?? '', /next run/u);
  assert.ok(
    openProjectMarket(options)
      .events()
      .some(
        (event) =>
          event.type === 'market_install' &&
          event.result === 'applied' &&
          event.run_id === done.id &&
          event.session_id === done.sessionId,
      ),
  );
  assert.equal(
    known.catalog.some(({ name }) => name === 'study-note-checklist'),
    false,
  );
  assert.equal(
    projectSkills(options)?.catalog.some(({ name }) => name === 'study-note-checklist'),
    true,
  );
});

test('market UI can list a saved gate decision and read its report without a provider', (t) => {
  const options = project(t);
  const market = marketOperations(options);
  const id = randomUUID();
  const gate = join(options.stateDir, 'market', 'gates', id);
  mkdirSync(gate, { recursive: true });
  writeFileSync(
    join(gate, 'manifest.json'),
    JSON.stringify({ candidate: { name: 'progress-summary', version: '1.1.0' } }),
  );
  assert.match(JSON.stringify(market.gates({})), /pending/u);
  writeFileSync(
    join(gate, 'decision.json'),
    JSON.stringify({ allowed: false, reason: 'regression', rows: [] }),
  );
  writeFileSync(join(gate, 'report.md'), '# A/B actual report\n');
  assert.match(JSON.stringify(market.gates({})), /rejected/u);
  assert.match(JSON.stringify(market['gate-report']({ id })), /actual report/u);
  assert.throws(() => market['gate-report']({ id: '../outside' }), /ID проверки/u);
});

test('a recreated runtime resumes with its saved marketplace revision and selection', async (t) => {
  const options = project(t);
  const operations = marketOperations(options);
  const market = openProjectMarket(options);
  await operations.install({ name: 'progress-summary', version: '1.0.0' });
  const workspace = new Workspace(options.workspace, readPolicy(options.policy));
  const call = (id: string, name: string, args: Record<string, unknown>): ModelReply => ({
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    },
  });
  function runtime(skillSet: ReturnType<typeof projectSkills>) {
    return new Agent({
      workspace,
      stateDir: options.stateDir,
      tools: skillSet?.tools,
      systemPrompt: skillSet?.systemPrompt,
      initialEvents: skillSet?.initialEvents,
      model: {
        async complete(messages) {
          const last = messages.at(-1);
          if (last?.role !== 'tool')
            return call('prepare-report', 'write_file', { path: 'report.md', content: '# Report' });
          if (last.tool_call_id === 'prepare-report')
            return call('load-report-skill', 'load_skill', { name: 'progress-summary' });
          const result = JSON.parse(last.content) as { output: { instructions: string } };
          assert.match(result.output.instructions, /Reconcile the per-learner counts/u);
          assert.doesNotMatch(result.output.instructions, /Before returning, verify the sum/u);
          return { message: { role: 'assistant', content: 'Baseline instructions still active.' } };
        },
      },
    });
  }
  const pending = await runtime(projectSkills(options)).start({
    prompt: 'Prepare the learner report',
    mode: 'safe',
  });
  assert.equal(pending.status, 'awaiting_confirmation');
  assert.match(JSON.stringify(pending.events), /market_skill_snapshot.+1\.0\.0/u);
  const stable = await market.stage('progress-summary', '1.1.0', 'demo');
  market.activate(stable.name, stable.version, stable.digest, market.active()[0]);
  changeSkillSelection(options, 'disable', 'progress-summary');
  assert.equal(
    projectSkills(options)?.catalog.find(({ name }) => name === 'progress-summary')?.enabled,
    false,
  );

  const saved = runtime(undefined).get(pending.id);
  const resumed = await runtime(projectSkills(options, saved)).resume(pending.id, 'approve');
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.final, 'Baseline instructions still active.');
  assert.equal(market.active()[0]?.version, '1.1.0');
});

test('evaluation jobs are enqueued without waiting for a worker and guard report identifiers', (t) => {
  const options = project(t);
  const launched: string[] = [];
  const jobs = evaluationOperations(options, (directory) => {
    launched.push(directory);
  });
  assert.deepEqual(jobs.list(), []);

  const base = jobs.run({ suite: 'base' });
  const extended = jobs.run({ suite: 'extended' });
  assert.equal(base.status, 'queued');
  assert.equal(base.totalTrials, 18);
  assert.equal(extended.totalTrials, 30);
  assert.notEqual(base.id, extended.id);
  assert.equal(launched.length, 2);
  assert.equal(jobs.list().length, 2);
  assert.throws(() => jobs.report({ id: '../outside' }), /ID/u);
  assert.throws(() => jobs.run({ suite: 'unknown' }), /base или extended/u);

  mkdirSync(base.output);
  writeFileSync(join(base.output, 'report.md'), '# Пробный отчёт\n');
  assert.deepEqual(jobs.report({ id: base.id }), { job: base, content: '# Пробный отчёт\n' });
});

test('evaluation queue persists a worker-launch failure', (t) => {
  const options = project(t);
  const jobs = evaluationOperations(options, (_directory, error) =>
    error(new Error('launch failed')),
  );
  const job = jobs.run({});
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'launch failed');
  assert.equal(jobs.list()[0]?.error, 'launch failed');
});
