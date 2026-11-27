import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import { parseOptions } from '../src/cli/options.js';
import { defaultEnvPath, installationRoot, resolvePaths } from '../src/cli/paths.js';

function temporary(t: TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workbench-cli-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('calling from the checkout root keeps the checked-in demo defaults', () => {
  const options = parseOptions([], installationRoot);
  assert.equal(options.workspace, join(installationRoot, 'workspace'));
  assert.equal(options.stateDir, join(installationRoot, '.agent'));
  assert.equal(options.policy, join(installationRoot, 'config', 'policy.json'));
  assert.equal(options.mcpConfig, join(installationRoot, 'config', 'mcp.json'));
  assert.deepEqual(options.skillDirs, [join(installationRoot, 'skills')]);
  assert.deepEqual(options.projectSkillDirs, [join(installationRoot, 'workspace', '.agent')]);
  assert.equal(options.envFile, defaultEnvPath);
  assert.equal(options.explicitEnvFile, false);
});

test('external projects use their cwd with an isolated state and trusted installation files', (t) => {
  const directory = temporary(t);
  const workspace = join(directory, 'project');
  const otherProject = join(directory, 'other');
  const symlink = join(directory, 'alias');
  const xdg = join(directory, 'state');
  mkdirSync(workspace);
  mkdirSync(otherProject);
  symlinkSync(workspace, symlink, 'dir');

  const options = resolvePaths({}, workspace, { XDG_STATE_HOME: xdg });
  assert.equal(options.workspace, workspace);
  assert.equal(options.policy, join(installationRoot, 'config', 'policy.json'));
  assert.equal(options.mcpConfig, join(installationRoot, 'config', 'mcp.json'));
  assert.equal(options.envFile, defaultEnvPath);
  assert.ok(options.stateDir.startsWith(join(xdg, 'workbench-agent', 'projects') + sep));
  assert.equal(resolvePaths({}, symlink, { XDG_STATE_HOME: xdg }).stateDir, options.stateDir);
  assert.notEqual(
    resolvePaths({}, otherProject, { XDG_STATE_HOME: xdg }).stateDir,
    options.stateDir,
  );
});

test('state selection rejects an XDG path inside the workspace even through a symlink', (t) => {
  const directory = temporary(t);
  const workspace = join(directory, 'project');
  const alias = join(directory, 'cache');
  mkdirSync(workspace);
  symlinkSync(workspace, alias, 'dir');

  const { stateDir } = resolvePaths({}, workspace, { XDG_STATE_HOME: join(alias, '.state') });
  assert.ok(relative(workspace, stateDir).startsWith('..' + sep));
});

test('explicit inputs resolve from the caller and feature opt-outs still win', (t) => {
  const directory = temporary(t);
  const options = parseOptions(
    [
      '--workspace',
      'subproject',
      '--policy',
      'settings/readonly.json',
      '--state-dir',
      '../external-state',
      '--env-file',
      'settings/model.env',
      '--skills-dir',
      'one',
      '--skills-dir',
      'two',
      '--mcp-config',
      'settings/mcp.json',
    ],
    directory,
  );

  assert.equal(options.workspace, join(directory, 'subproject'));
  assert.equal(options.policy, join(directory, 'settings/readonly.json'));
  assert.equal(options.stateDir, join(directory, '../external-state'));
  assert.equal(options.envFile, join(directory, 'settings/model.env'));
  assert.equal(options.explicitEnvFile, true);
  assert.deepEqual(options.skillDirs, [join(directory, 'one'), join(directory, 'two')]);
  assert.equal(options.mcpConfig, join(directory, 'settings/mcp.json'));
  const disabled = parseOptions(
    ['--no-skills', '--skills-dir', 'one', '--no-mcp', '--mcp-config', 'settings/mcp.json'],
    directory,
  );
  assert.deepEqual(disabled.skillDirs, []);
  assert.deepEqual(disabled.projectSkillDirs, []);
  assert.equal(disabled.mcpConfig, undefined);
});

test('the installed executable can print help through a link from an unrelated cwd', (t) => {
  const directory = temporary(t);
  const link = join(directory, 'workbench-agent');
  symlinkSync(join(installationRoot, 'bin', 'workbench-agent.mjs'), link);
  const output = spawnSync(link, ['--help'], { cwd: directory, encoding: 'utf8', timeout: 10_000 });
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stdout, /\bchat\b/u);
  assert.match(output.stdout, /--workspace/u);
});
