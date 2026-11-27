import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadSkills } from '../src/skills/index.js';

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
