import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Market, readMarketConfig } from '../src/market/index.js';
import { loadSkills } from '../src/skills/index.js';

const fixture = resolve('market-fixtures');
const configuration = join(fixture, 'config.json');
const skill = 'progress-summary';

test('market keeps immutable staged versions, an atomic current pointer and durable rollback', async (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'market-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const create = () => new Market({ root, registries: readMarketConfig(configuration) });
  const market = create();

  assert.deepEqual(
    (await market.search('progress')).map(({ version }) => version),
    ['2.0.0', '1.1.0', '1.0.0'],
  );
  assert.equal((await market.search('missing')).length, 0);
  assert.equal((await market.news())[0]?.version, '2.0.0');
  const baseline = await market.stage(skill, '1.0.0');
  assert.deepEqual(readdirSync(join(baseline.root, skill)), ['SKILL.md']);
  assert.deepEqual(market.activeRoots(), []);
  assert.deepEqual(await market.stage(skill, '1.0.0'), baseline);
  assert.throws(() => market.activate(skill, '1.0.0', '0'.repeat(64), null), /digest/i);
  market.activate(skill, '1.0.0', baseline.digest, null);
  assert.match(loadSkills(market.activeRoots()).systemPrompt, /progress-summary/u);

  const candidate = await market.stage(skill, '1.1.0');
  assert.equal(market.list()[0]?.active?.version, '1.0.0');
  market.activate(skill, '1.1.0', candidate.digest, baseline);
  assert.equal(create().active()[0]?.version, '1.1.0');
  assert.equal(create().rollback(skill).version, '1.0.0');
  assert.equal(market.active()[0]?.version, '1.0.0');
  assert.throws(
    () => market.activate(skill, '1.1.0', candidate.digest, candidate),
    /active version has changed/iu,
  );
  assert.deepEqual(
    market.list()[0]?.history.map(({ action, version }) => [action, version]),
    [
      ['activate', '1.0.0'],
      ['activate', '1.1.0'],
      ['rollback', '1.0.0'],
    ],
  );
  await assert.rejects(market.stage('../outside', '1.0.0'), /name/iu);
  await assert.rejects(market.stage(skill, '01.1.0'), /version/iu);
});

test('market fetches a real HTTP registry, validates digests and gates automatic updates', async (t) => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'market-http-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let index = 'index-stable.json';
  let corrupt = false;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    requests.push(path);
    if (path === '/index') {
      response.end(readFileSync(join(fixture, index)));
      return;
    }
    const url = /^\/skills\/progress-summary\/(1\.0\.0|1\.1\.0|2\.0\.0)\/SKILL\.md$/u.exec(path);
    if (!url) {
      response.writeHead(404).end();
      return;
    }
    const source = readFileSync(join(fixture, path));
    response.end(corrupt ? Buffer.concat([source, Buffer.from('corruption')]) : source);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  const market = new Market({
    root: join(directory, 'installed'),
    registries: [{ id: 'http-local', index: `http://127.0.0.1:${port}/index` }],
  });
  const baseline = await market.stage(skill, '1.0.0');
  market.activate(skill, baseline.version, baseline.digest, null);

  const [staged] = await market.reconcile();
  assert.equal(staged?.status, 'staged');
  assert.equal(staged?.staged?.version, '1.1.0');
  assert.equal(market.active()[0]?.version, '1.0.0');
  const [accepted] = await market.reconcile(async (candidate, current) => {
    assert.equal(candidate.version, '1.1.0');
    assert.equal(current.digest, baseline.digest);
    return true;
  });
  assert.equal(accepted?.status, 'activated');
  assert.equal(market.active()[0]?.version, '1.1.0');

  index = 'index.json';
  corrupt = true;
  await assert.rejects(market.stage(skill, '2.0.0'), /SHA-256 mismatch/u);
  assert.equal(
    market.list()[0]?.versions.some(({ version }) => version === '2.0.0'),
    false,
  );
  corrupt = false;
  const [blocked] = await market.reconcile(async () => false);
  assert.equal(blocked?.status, 'blocked');
  assert.equal(blocked?.staged?.version, '2.0.0');
  assert.equal(market.active()[0]?.version, '1.1.0');

  const [stale] = await market.reconcile(async () => {
    market.rollback(skill);
    return true;
  });
  assert.equal(stale?.status, 'failed');
  assert.match(stale.error ?? '', /active version has changed/iu);
  assert.equal(market.active()[0]?.version, '1.0.0');
  assert.deepEqual([...new Set(requests)].sort(), [
    '/index',
    '/skills/progress-summary/1.0.0/SKILL.md',
    '/skills/progress-summary/1.1.0/SKILL.md',
    '/skills/progress-summary/2.0.0/SKILL.md',
  ]);
});

test('market refuses traversal, artifact symlinks and changes to an installed version', async (t) => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'market-boundary-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'local');
  mkdirSync(source);
  symlinkSync(join(fixture, 'skills'), join(source, 'skills'), 'dir');
  const index = readFileSync(join(fixture, 'index-baseline.json'), 'utf8');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(source, 'index.json'), index);
  const omitted = new Market({
    root: join(directory, 'installed'),
    registries: [{ id: 'local', index: join(source, 'index.json') }],
  });
  await assert.rejects(omitted.stage(skill), /symlink/u);
  writeFileSync(join(source, 'index.json'), index.replace('skills/progress', '../skills/progress'));
  await assert.rejects(omitted.search(), /relative path/iu);

  const installed = new Market({
    root: join(directory, 'verified'),
    registries: readMarketConfig(configuration),
  });
  const version = await installed.stage(skill, '1.0.0');
  const file = join(version.root, skill, 'SKILL.md');
  rmSync(file);
  writeFileSync(file, 'tampered');
  assert.throws(
    () => installed.activate(skill, version.version, version.digest, null),
    /SHA-256 validation/u,
  );
});
