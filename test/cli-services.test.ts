import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { evaluationOperations } from '../src/cli/eval-operations.js';
import {
  marketOperations,
  openProjectMarket,
  startMarketWatcher,
} from '../src/cli/market-commands.js';
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
  assert.deepEqual(market.auto({ action: 'status' }), { enabled: false, intervalMinutes: 60 });
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
