import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorBuffer, type EditorKey } from '../src/cli/editor.js';

const press = (editor: EditorBuffer, name: string, modifiers: Omit<EditorKey, 'name'> = {}) =>
  editor.key(undefined, { name, ...modifiers });

const type = (editor: EditorBuffer, text: string) => editor.key(text, {});

test('Shift+Tab cycles the mode without editing the draft; Tab completes the highlighted command', () => {
  const editor = new EditorBuffer(() => [
    { name: '/stats', description: 'Show usage' },
    { name: '/session', description: 'Change session' },
  ]);
  type(editor, '/s');
  press(editor, 'down');
  assert.deepEqual(press(editor, 'tab', { shift: true }), { type: 'cycle' });
  assert.equal(editor.view().text, '/s');
  assert.equal(editor.view().selected, 1);
  assert.deepEqual(press(editor, 'tab'), { type: 'change' });
  assert.equal(editor.view().text, '/session');
  assert.equal(press(editor, 'tab'), undefined);
  assert.deepEqual(press(editor, 'return'), { type: 'submit', text: '/session' });
  type(editor, 'draft');
  assert.equal(press(editor, 'tab'), undefined);
  assert.equal(editor.view().text, 'draft');
});

test('Ctrl+U clears the full multiline draft from its middle', () => {
  const editor = new EditorBuffer();
  type(editor, 'первая');
  press(editor, 'return', { meta: true });
  type(editor, 'вторая');
  press(editor, 'enter');
  type(editor, 'третья');
  press(editor, 'up');
  press(editor, 'home');
  assert.equal(editor.view().text, 'первая\nвторая\nтретья');
  assert.equal(editor.view().cursor, 7);

  press(editor, 'u', { ctrl: true });
  assert.equal(editor.view().text, '');
  assert.equal(editor.view().cursor, 0);
});

test('slash hints support selection, completion and exact command dispatch', () => {
  const editor = new EditorBuffer(() => [
    { name: '/stats', description: 'Show usage' },
    { name: '/session', description: 'Change session' },
  ]);
  type(editor, '/s');
  press(editor, 'down');
  assert.equal(editor.view().selected, 1);
  assert.deepEqual(press(editor, 'return'), { type: 'change' });
  assert.equal(editor.view().text, '/session');
  type(editor, ' new');
  assert.deepEqual(press(editor, 'return'), { type: 'submit', text: '/session new' });

  type(editor, '/s');
  press(editor, 'right');
  assert.equal(editor.view().text, '/stats');
  assert.deepEqual(press(editor, 'return'), { type: 'submit', text: '/stats' });
});

test('bracketed paste inserts mixed line endings without submitting or handling shortcuts', () => {
  const editor = new EditorBuffer();
  press(editor, 'paste-start');
  type(editor, 'первая');
  press(editor, 'return');
  press(editor, 'enter');
  press(editor, 'tab');
  type(editor, '\u001b[31mвторая\u001b[0m');
  assert.equal(editor.view().text, '');
  assert.deepEqual(press(editor, 'paste-end'), { type: 'change' });
  assert.equal(editor.view().text, 'первая\n    вторая');
  assert.deepEqual(press(editor, 'return'), { type: 'submit', text: 'первая\n    вторая' });
});

test('movement and deletion preserve emoji clusters and combined characters', () => {
  const editor = new EditorBuffer();
  const emoji = '👩🏽‍💻';
  type(editor, `a${emoji}e\u0301z`);
  press(editor, 'left');
  press(editor, 'backspace');
  assert.equal(editor.view().text, `a${emoji}z`);
  press(editor, 'left');
  assert.equal(editor.view().cursor, 1);
  press(editor, 'delete');
  assert.equal(editor.view().text, 'az');
});

test('history restores the draft; Ctrl+C clears a draft, requests interruption or exits', () => {
  const editor = new EditorBuffer();
  type(editor, 'сообщение');
  press(editor, 'return');
  type(editor, 'черновик');
  press(editor, 'up');
  assert.equal(editor.view().text, 'сообщение');
  press(editor, 'down');
  assert.equal(editor.view().text, 'черновик');

  editor.setBusy(true);
  assert.deepEqual(press(editor, 'c', { ctrl: true }), { type: 'change' });
  assert.deepEqual(press(editor, 'c', { ctrl: true }), { type: 'interrupt' });
  press(editor, 'paste-start');
  type(editor, 'follow-up');
  press(editor, 'paste-end');
  assert.deepEqual(press(editor, 'return'), { type: 'submit', text: 'follow-up' });

  editor.setBusy(false);
  assert.deepEqual(press(editor, 'c', { ctrl: true }), { type: 'exit' });
});
