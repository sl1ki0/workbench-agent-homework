import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { changes, readPolicy, Workspace, type Policy } from '../src/workspace/index.js';

const policyPath = join(process.cwd(), 'config/policy.json');

function fixture(t: TestContext, policy = readPolicy(policyPath)) {
  const parent = mkdtempSync(join(tmpdir(), 'course-workspace-'));
  const root = join(parent, 'workspace');
  mkdirSync(root);
  t.after(() => rmSync(parent, { force: true, recursive: true }));
  return { workspace: new Workspace(root, policy), root, parent };
}

function bashPolicy(allow: string[], deny: string[] = []): Policy {
  return {
    ...readPolicy(policyPath),
    commands: { allow, deny },
    bash: { timeoutMs: 100, maxOutputBytes: 1000 },
  };
}

test('policy denies traversal, absolute paths, protected files and forbidden subdirectories', (t) => {
  const { workspace, root, parent } = fixture(t);
  mkdirSync(join(root, 'private'));
  writeFileSync(join(root, 'private', 'data.txt'), 'restricted');
  writeFileSync(join(root, 'test_order.py'), 'existing contract');
  writeFileSync(join(parent, 'outside.txt'), 'outside');

  assert.equal(workspace.read('test_order.py', 100).content, 'existing contract');
  assert.throws(() => workspace.write('test_order.py', 'modified contract'), /read-only/);
  assert.throws(() => workspace.read('private/data.txt', 100), /denied by policy/);
  assert.throws(() => workspace.read('PRIVATE/data.txt', 100), /denied by policy/);
  assert.throws(() => workspace.read('../outside.txt', 100), /traversal/);
  assert.throws(() => workspace.read(join(parent, 'outside.txt'), 100), /workspace-relative/);
  assert.deepEqual([...workspace.paths('.')], ['test_order.py']);
});

test('filesystem refuses indirection and enforces exact allowed-directory boundaries', (t) => {
  const policy = readPolicy(policyPath);
  policy.directories.allow = ['public'];
  const { workspace, root, parent } = fixture(t, policy);
  mkdirSync(join(root, 'public'));
  mkdirSync(join(root, 'public-other'));
  writeFileSync(join(parent, 'outside.txt'), 'outside');
  writeFileSync(join(root, 'public-other', 'data.txt'), 'unauthorized sibling');
  symlinkSync(join(parent, 'outside.txt'), join(root, 'public', 'link.txt'));
  symlinkSync(parent, join(root, 'public', 'directory-link'));
  linkSync(join(parent, 'outside.txt'), join(root, 'public', 'hardlink.txt'));

  assert.throws(() => workspace.read('public-other/data.txt', 100), /denied by policy/);
  assert.throws(() => workspace.read('public/link.txt', 100), /Symbolic links are forbidden/);
  assert.throws(
    () => workspace.write('public/directory-link/new.txt', 'escape'),
    /Symbolic links are forbidden/,
  );
  assert.throws(() => workspace.read('public/hardlink.txt', 100), /singly-linked/);
  assert.equal(existsSync(join(parent, 'new.txt')), false);
});

test('Bash requires an exact allowed simple command and an authorized cwd', (t) => {
  const { workspace, root } = fixture(
    t,
    bashPolicy(
      [
        'python3 -m unittest -v',
        'pwd',
        'pwd | ls',
        'bash -c pwd',
        'printf >outside',
        'cat private',
      ],
      ['pwd'],
    ),
  );
  mkdirSync(join(root, 'private'));

  assert.deepEqual(workspace.bash('python3 -m unittest -v', '.').tokens, [
    'python3',
    '-m',
    'unittest',
    '-v',
  ]);
  assert.throws(() => workspace.bash('pwd', '.'), /denied by policy/);
  assert.throws(() => workspace.bash('python3 -m unittest -v', 'private'), /denied by policy/);
  assert.throws(() => workspace.bash('python3 -m unittest  -v', '.'), /denied by policy/);
  assert.throws(() => workspace.bash('pwd | ls', '.'), /simple, literal arguments/);
  assert.throws(() => workspace.bash('bash -c pwd', '.'), /simple, literal arguments/);
  assert.throws(() => workspace.bash('printf >outside', '.'), /simple, literal arguments/);
  assert.throws(() => workspace.bash('cat private', '.'), /argument denied by policy/);
});

test('Bash caps combined output, reports exit codes and stops at a timeout', async (t) => {
  const { workspace } = fixture(t, bashPolicy(['printf abcdef', 'sleep 2', 'false']));
  const tool = workspace.tools().find(({ name }) => name === 'Bash');
  assert.ok(tool);
  const context = { maxBytes: 3, runId: 'run', sessionId: 'session' };

  const bounded = await tool.execute({ command: 'printf abcdef', cwd: '.' }, context);
  assert.equal(bounded.ok, true);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(bounded.output, { stdout: 'abc', stderr: '', exitCode: 0, signal: null });

  const unsuccessful = await tool.execute({ command: 'false', cwd: '.' }, context);
  assert.equal(unsuccessful.ok, false);
  assert.deepEqual(unsuccessful.output, { stdout: '', stderr: '', exitCode: 1, signal: null });

  const timedOut = await tool.execute({ command: 'sleep 2', cwd: '.' }, context);
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error ?? '', /timed out after 100 ms/);
});

test('snapshot round-trip captures creation, modification, deletion and permission bits', (t) => {
  const { workspace, root } = fixture(t);
  writeFileSync(join(root, 'script'), 'old script');
  chmodSync(join(root, 'script'), 0o751);
  writeFileSync(join(root, 'delete.txt'), 'removed later');
  writeFileSync(join(root, '__proto__'), 'legitimate filename');
  const before = workspace.snapshot();

  workspace.write('script', 'updated script');
  workspace.write('new.txt', 'added');
  workspace.delete('delete.txt');
  const after = workspace.snapshot();
  const recorded = changes(JSON.parse(JSON.stringify(before)), JSON.parse(JSON.stringify(after)));
  assert.deepEqual(
    recorded.map(({ path, before, after }) => [path, before !== null, after !== null]),
    [
      ['delete.txt', true, false],
      ['new.txt', false, true],
      ['script', true, true],
    ],
  );

  writeFileSync(join(root, 'unrelated.txt'), 'outside edit');
  new Workspace(root, readPolicy(policyPath)).rollback(recorded);
  assert.equal(existsSync(join(root, 'new.txt')), false);
  assert.equal(readFileSync(join(root, 'script'), 'utf8'), 'old script');
  assert.equal(statSync(join(root, 'script')).mode & 0o777, 0o751);
  assert.equal(readFileSync(join(root, 'delete.txt'), 'utf8'), 'removed later');
  assert.equal(readFileSync(join(root, 'unrelated.txt'), 'utf8'), 'outside edit');
});

test('rollback checks every changed file before modifying any file', (t) => {
  const { workspace, root } = fixture(t);
  workspace.write('a.txt', 'initial A');
  workspace.write('z.txt', 'initial Z');
  const before = workspace.snapshot();
  workspace.write('a.txt', 'agent A');
  workspace.write('z.txt', 'agent Z');
  const diff = changes(before, workspace.snapshot());
  writeFileSync(join(root, 'z.txt'), 'external Z');

  assert.throws(() => workspace.rollback(diff), /Rollback conflict: z.txt/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'agent A');
  assert.equal(readFileSync(join(root, 'z.txt'), 'utf8'), 'external Z');
});
