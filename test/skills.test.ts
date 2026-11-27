import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadSkills, readSkillSelection, writeSkillSelection } from '../src/skills/index.js';

function add(directory: string, folder: string, frontmatter: string, instructions: string): void {
  const path = join(directory, folder);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${instructions}\n`);
}

test('skills disclose only metadata until model-driven activation and survive malformed neighbors', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-skills-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  add(directory, 'good', 'name: good\ndescription: Use for lesson totals', 'PRIVATE STEP MARKER');
  add(directory, 'bad-yaml', 'name: [', 'Bad');
  add(directory, 'mismatch', 'name: another\ndescription: Wrong folder', 'Bad');

  const loaded = loadSkills([directory]);
  const catalog = loaded.initialEvents.find((event) => event.type === 'skills_discovered');
  assert.deepEqual(catalog?.data.skills, [{ name: 'good', description: 'Use for lesson totals' }]);
  assert.equal(loaded.initialEvents.filter((event) => event.type === 'skill_error').length, 2);
  assert.match(loaded.systemPrompt, /lesson totals/u);
  assert.doesNotMatch(loaded.systemPrompt, /PRIVATE STEP MARKER/u);

  const tool = loaded.tools[0];
  if (!tool) assert.fail('Activation tool is missing');
  const context = { runId: 'r1', sessionId: 's1', maxBytes: 2048 };
  assert.equal(tool.sideEffect, false);
  assert.match(
    JSON.stringify(await tool.execute({ name: 'good' }, context)),
    /PRIVATE STEP MARKER/u,
  );
  assert.equal((await tool.execute({ name: '../../outside' }, context)).ok, false);

  add(directory, 'new-skill', 'name: new-skill\ndescription: Newly installed skill', 'Check work');
  assert.doesNotMatch(loaded.systemPrompt, /new-skill/u);
  assert.match(loadSkills([directory]).systemPrompt, /new-skill/u);
});

test('workspace .agent skills and selections expose only active metadata to the model', async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'workbench-skills-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const projectRoot = join(directory, 'project', '.agent');
  const stateDir = join(directory, 'state');
  add(
    join(projectRoot, 'skills'),
    'review',
    'name: review\ndescription: Review code',
    'SECRET REVIEW BODY',
  );
  add(projectRoot, 'notes', 'name: notes\ndescription: Edit notes', 'SECRET NOTE BODY');
  mkdirSync(join(projectRoot, 'logs'));
  assert.deepEqual(readSkillSelection(stateDir), { enabled: true, disabled: [] });
  writeSkillSelection(stateDir, { enabled: true, disabled: ['review', 'review'] });
  assert.deepEqual(readSkillSelection(stateDir), { enabled: true, disabled: ['review'] });

  const options = { ...readSkillSelection(stateDir), projectRoots: [projectRoot] };
  const catalog = loadSkills([], options);
  assert.deepEqual(
    catalog.catalog.map(({ name, enabled }) => [name, enabled]),
    [
      ['review', false],
      ['notes', true],
    ],
  );
  assert.ok(catalog.catalog.every(({ estimatedTokens }) => estimatedTokens > 0));
  assert.equal(catalog.initialEvents.filter(({ type }) => type === 'skill_error').length, 0);
  assert.match(catalog.systemPrompt, /"name":"notes"/u);
  assert.doesNotMatch(catalog.systemPrompt, /review|SECRET/u);
  const tool = catalog.tools[0];
  assert.ok(tool);
  assert.doesNotMatch(JSON.stringify(tool.schema), /review/u);
  const context = { runId: 'r1', sessionId: 's1', maxBytes: 2048 };
  assert.equal((await tool.execute({ name: 'review' }, context)).ok, false);
  assert.match(JSON.stringify(await tool.execute({ name: 'notes' }, context)), /SECRET NOTE BODY/u);

  writeSkillSelection(stateDir, { ...readSkillSelection(stateDir), enabled: false });
  const off = loadSkills([], { ...readSkillSelection(stateDir), projectRoots: [projectRoot] });
  assert.equal(off.catalog.length, 2);
  assert.ok(off.catalog.every(({ enabled }) => !enabled));
  assert.deepEqual(off.tools, []);
  assert.equal(off.systemPrompt, '');
});

test('project discovery never follows a symlinked .agent or skills directory', (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'workbench-skills-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outside = join(directory, 'outside');
  const workspace = join(directory, 'workspace');
  add(join(outside, 'skills'), 'hidden', 'name: hidden\ndescription: Private', 'Secret');
  mkdirSync(workspace);
  const projectRoot = join(workspace, '.agent');
  symlinkSync(outside, projectRoot, 'dir');

  const result = loadSkills([], { projectRoots: [projectRoot] });
  assert.equal(result.catalog.length, 0);
  assert.ok(result.initialEvents.some(({ type }) => type === 'skill_error'));
  unlinkSync(projectRoot);
  mkdirSync(projectRoot);
  symlinkSync(join(outside, 'skills'), join(projectRoot, 'skills'), 'dir');
  assert.equal(loadSkills([], { projectRoots: [projectRoot] }).catalog.length, 0);
});
