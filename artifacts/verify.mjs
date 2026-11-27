import assert from 'node:assert/strict';
import { log } from 'node:console';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const artifacts = dirname(fileURLToPath(import.meta.url));
const repo = resolve(artifacts, '..');

function data(folder, path) {
  const root = resolve(artifacts, folder);
  const file = resolve(root, path);
  const inside = relative(root, file);
  assert.ok(inside && inside !== '..' && !inside.startsWith('../') && !isAbsolute(inside), path);
  return readFileSync(file, 'utf8');
}

const json = (folder, path) => JSON.parse(data(folder, path));
const jsonl = (folder, path) =>
  data(folder, path).trim().split('\n').filter(Boolean).map(JSON.parse);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function sources(digests, copies = new Map()) {
  for (const [path, expected] of Object.entries(digests)) {
    const absolute = resolve(repo, path);
    const inside = relative(repo, absolute);
    assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside), path);
    const version = path.match(/^\.agent\/.*\/market\/versions\/([^/]+)\/([^/]+)\//u);
    const published = version ? copies.get(`${version[1]}@${version[2]}`) : absolute;
    assert.ok(published, path);
    assert.equal(sha256(readFileSync(published)), expected, path);
  }
}

function series(folder, kind) {
  const manifest = json(folder, 'manifest.json');
  const rows = jsonl(folder, 'trials.jsonl');
  assert.equal(manifest.experiment, kind, folder);
  assert.equal(manifest.scenarios.length, 5, folder);
  assert.equal(manifest.order.length, 30, folder);
  assert.equal(rows.length, 30, folder);
  assert.ok(manifest.model?.model && manifest.model.model !== 'unit-test-adapter', folder);

  const sessions = new Set();
  const runs = new Set();
  const cases = new Map();
  for (const [index, row] of rows.entries()) {
    const { case_id: id, variant, trial, run_id: run, session_id: session } = row;
    const scenarioKey = `${id}/${variant}`;
    cases.set(scenarioKey, (cases.get(scenarioKey) ?? 0) + 1);
    assert.deepEqual([id, variant, trial], manifest.order[index], `${folder} row ${index}`);
    assert.ok(run && session && !runs.has(run) && !sessions.has(session), `${folder} row ${index}`);
    runs.add(run);
    sessions.add(session);
    const detail = json(folder, `trials/${id}/${variant}${trial}/result.json`);
    assert.equal(detail.run_id, run);
    assert.equal(detail.outcome_pass, row.outcome_pass);
    assert.equal(detail.routing_pass_or_na, row.routing_pass_or_na);
    const events = jsonl(folder, row.journal);
    assert.ok(events.length > 0);
    const eventIds = new Set();
    for (const event of events) {
      assert.ok(event.id && !eventIds.has(event.id));
      assert.ok(Number.isFinite(Date.parse(event.time)));
      assert.equal(event.run_id, run);
      assert.equal(event.session_id, session);
      eventIds.add(event.id);
    }
    assert.ok(events.some(({ type }) => type === 'run_finished'));
    assert.ok(Number.isInteger(row.input_tokens) || row.input_tokens === null);
    assert.ok(Number.isInteger(row.output_tokens) || row.output_tokens === null);
    if (row.artifact) data(folder, row.artifact);
  }
  assert.equal(cases.size, 10);
  assert.ok([...cases.values()].every((count) => count === 3));
  assert.ok(data(folder, 'report.md').includes('[Журнал') || kind === 'version-update');
  return { manifest, rows };
}

const ab = series('ab', 'A/B');
assert.deepEqual(
  [ab.manifest.configurations.A.skills, ab.manifest.configurations.B.skills],
  [false, true],
);
assert.equal(json('ab', 'completion.json').frozen_files_verified, true);
assert.ok(ab.rows.every((row) => row.variant !== 'A' || row.routing_pass_or_na === 'n/a'));
sources(ab.manifest.files_sha256);

const update = series('update', 'version-update');
assert.deepEqual(
  [update.manifest.configurations.A.skills, update.manifest.configurations.B.skills],
  [true, true],
);
const decision = json('update', 'decision.json');
assert.equal(typeof decision.allowed, 'boolean');
assert.deepEqual(decision.rows, update.rows);
assert.ok(decision.reason);
const copies = new Map();
for (const [variant, metadata] of [
  ['A', decision.baseline],
  ['B', decision.candidate],
]) {
  const path = `versions/${variant}/${metadata.name}/SKILL.md`;
  assert.equal(sha256(data('update', path)), metadata.digest);
  copies.set(`${metadata.name}@${metadata.version}`, resolve(artifacts, 'update', path));
}
sources(update.manifest.sourceDigests, copies);
assert.deepEqual(ab.manifest.model, update.manifest.model);
const activeAfter = json('update', 'active-after-decision.json');
const selected = decision.allowed ? decision.candidate : decision.baseline;
assert.ok(
  activeAfter.some(
    ({ name, version, digest }) =>
      name === selected.name && version === selected.version && digest === selected.digest,
  ),
);

const doctor = json('doctor', 'findings.json');
const diagnoses = doctor.runs.flatMap(({ findings }) => findings);
assert.deepEqual(
  new Set(diagnoses.map(({ type }) => type)),
  new Set(['repeated_error', 'repeated_read']),
);
for (const finding of diagnoses) {
  const events = jsonl('doctor', `events/${finding.run_id}.jsonl`);
  assert.ok(events.every(({ session_id }) => session_id === doctor.session_id));
  assert.ok(finding.event_ids.every((id) => events.some((event) => event.id === id)));
}
for (const path of [
  'screenshots/03-task.png',
  'screenshots/04-follow-up.png',
  'screenshots/12-terminal-task.png',
  'screenshots/13-terminal-follow-up.png',
]) {
  assert.ok(existsSync(resolve(artifacts, path)), path);
}
log(
  'Артефакты проверены локально: A/B 30/30, сравнение версий 30/30, журналы, SHA-256, решение и скриншоты.',
);
