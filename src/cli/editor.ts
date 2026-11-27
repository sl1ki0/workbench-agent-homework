import { emitKeypressEvents } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';
import { stripVTControlCharacters } from 'node:util';

export interface CommandHint {
  name: string;
  description: string;
}

export interface EditorView {
  text: string;
  cursor: number;
  suggestions: CommandHint[];
  selected: number;
  busy: boolean;
}

interface EditorOptions {
  commands?(): CommandHint[];
  onChange(): void;
  onSubmit(text: string): void;
  onCycleMode(direction: 1 | -1): void;
  onExit(): void;
  onInterrupt?(): void;
}

export interface EditorKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

type EditorAction =
  | { type: 'submit'; text: string }
  | { type: 'cycle'; direction: 1 | -1 }
  | { type: 'exit' }
  | { type: 'interrupt' }
  | { type: 'change' };

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const historyLimit = 100;
const suggestionLimit = 6;

function boundary(text: string, cursor: number, minimum = 0): number {
  if (cursor >= text.length) return text.length;
  return Math.max(minimum, graphemes.segment(text).containing(Math.max(0, cursor))?.index ?? 0);
}

function cleanInput(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/\r\n?/gu, '\n')
    .replace(/\t/gu, '    ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '');
}

function pasteKey(text: string | undefined, key: EditorKey): string {
  if (key.name === 'return') return '\r';
  if (key.name === 'enter') return '\n';
  if (key.name === 'tab') return '\t';
  return text ?? '';
}

export class EditorBuffer {
  private text = '';
  private cursor = 0;
  private busy = false;
  private selected = 0;
  private dismissed = false;
  private paste: { parts: string[]; discard: boolean } | undefined;
  private readonly history: string[] = [];
  private historyIndex = 0;
  private parkedDraft = '';

  constructor(private readonly commands: () => CommandHint[] = () => []) {}

  view(): EditorView {
    return {
      text: this.text,
      cursor: this.cursor,
      suggestions: this.suggestions(),
      selected: this.selected,
      busy: this.busy,
    };
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  key(value: string | undefined, key: EditorKey): EditorAction | undefined {
    if (key.name === 'paste-start') {
      this.paste ??= { parts: [], discard: this.busy };
      return;
    }
    if (this.paste) {
      if (key.name !== 'paste-end') {
        if (!this.paste.discard) this.paste.parts.push(pasteKey(value, key));
        return;
      }
      const { parts, discard } = this.paste;
      this.paste = undefined;
      if (this.busy || discard) return;
      this.insert(parts.join(''));
      return { type: 'change' };
    }
    if (key.name === 'paste-end') return;

    if (key.name === 'c' && key.ctrl) {
      if (this.busy) return { type: 'interrupt' };
      if (!this.text) return { type: 'exit' };
      this.replace('');
      return { type: 'change' };
    }
    if (this.busy) return;
    if (key.name === 'tab') return { type: 'cycle', direction: key.shift ? -1 : 1 };
    if (key.name === 'd' && key.ctrl && !this.text) return { type: 'exit' };
    if (key.name === 'return' && !key.meta && !key.shift) return this.submit();

    switch (key.name) {
      case 'enter':
      case 'return':
        this.insert('\n');
        break;
      case 'escape':
        if (!this.suggestions().length) return;
        this.dismissed = true;
        this.selected = 0;
        break;
      case 'left':
        this.cursor = key.ctrl || key.meta ? this.wordLeft() : boundary(this.text, this.cursor - 1);
        break;
      case 'right':
        if (key.ctrl || key.meta) this.cursor = this.wordRight();
        else if (this.cursor < this.text.length) this.cursor = this.nextBoundary();
        else if (!this.acceptSuggestion()) return;
        break;
      case 'backspace':
        this.remove(boundary(this.text, this.cursor - 1), this.cursor);
        break;
      case 'delete':
        this.remove(this.cursor, this.nextBoundary());
        break;
      case 'up':
      case 'down':
        this.moveVertically(key.name === 'up' ? -1 : 1);
        break;
      case 'home':
        this.cursor = key.ctrl ? 0 : this.lineStart();
        break;
      case 'end':
        this.cursor = key.ctrl ? this.text.length : this.lineEnd();
        break;
      default:
        if (key.ctrl) {
          if (!this.control(key.name)) return;
        } else if (value && !key.meta && !value.startsWith('\u001b')) {
          this.insert(value);
        } else {
          return;
        }
    }
    return { type: 'change' };
  }

  private control(name: string | undefined): boolean {
    switch (name) {
      case 'u':
        this.replace('');
        return true;
      case 'a':
        this.cursor = this.lineStart();
        return true;
      case 'e':
        this.cursor = this.lineEnd();
        return true;
      case 'w':
        this.remove(this.wordLeft(), this.cursor);
        return true;
      case 'k':
        this.remove(this.cursor, this.lineEnd());
        return true;
      case 'd':
        this.remove(this.cursor, this.nextBoundary());
        return true;
      default:
        return false;
    }
  }

  private suggestions(): CommandHint[] {
    if (this.dismissed || !/^\/[^\s/]*$/u.test(this.text)) return [];
    const prefix = this.text.toLowerCase();
    return this.commands()
      .filter(({ name }) => name.toLowerCase().startsWith(prefix))
      .slice(0, suggestionLimit);
  }

  private acceptSuggestion(): boolean {
    const suggestion = this.suggestions()[this.selected];
    if (!suggestion || suggestion.name === this.text) return false;
    this.replace(suggestion.name);
    return true;
  }

  private submit(): EditorAction {
    const text = this.text.trim();
    if (!text) {
      this.replace('');
      return { type: 'change' };
    }
    const exact = this.suggestions().some(({ name }) => name === this.text);
    if (!exact && this.acceptSuggestion()) return { type: 'change' };

    if (this.history.at(-1) !== text) {
      this.history.push(text);
      if (this.history.length > historyLimit) this.history.shift();
    }
    this.replace('');
    return { type: 'submit', text };
  }

  private moveVertically(direction: 1 | -1): void {
    const suggestions = this.suggestions();
    if (suggestions.length) {
      this.selected = (this.selected + direction + suggestions.length) % suggestions.length;
      return;
    }

    const start = this.lineStart();
    const end = this.lineEnd();
    const column = this.cursor - start;
    if (direction === -1 && start > 0) {
      const lastEnd = start - 1;
      const lastStart = this.text.slice(0, lastEnd).lastIndexOf('\n') + 1;
      this.cursor = boundary(this.text, Math.min(lastEnd, lastStart + column), lastStart);
      return;
    }
    if (direction === 1 && end < this.text.length) {
      const nextStart = end + 1;
      const nextBreak = this.text.indexOf('\n', nextStart);
      const nextEnd = nextBreak === -1 ? this.text.length : nextBreak;
      this.cursor = boundary(this.text, Math.min(nextEnd, nextStart + column), nextStart);
      return;
    }
    if (!this.text.includes('\n')) this.moveHistory(direction);
  }

  private moveHistory(direction: 1 | -1): void {
    const previousIndex = this.historyIndex;
    this.historyIndex = Math.min(this.history.length, Math.max(0, previousIndex + direction));
    if (this.historyIndex === previousIndex) return;
    if (previousIndex === this.history.length) this.parkedDraft = this.text;
    this.assign(this.history[this.historyIndex] ?? this.parkedDraft);
  }

  private lineStart(): number {
    return this.text.slice(0, this.cursor).lastIndexOf('\n') + 1;
  }

  private lineEnd(): number {
    const newline = this.text.indexOf('\n', this.cursor);
    return newline === -1 ? this.text.length : newline;
  }

  private nextBoundary(): number {
    const next = graphemes.segment(this.text).containing(this.cursor);
    return next ? next.index + next.segment.length : this.text.length;
  }

  private wordLeft(): number {
    const length = /\S*\s*$/u.exec(this.text.slice(0, this.cursor))?.[0].length ?? 0;
    return boundary(this.text, this.cursor - length);
  }

  private wordRight(): number {
    const length = /^\s*\S*/u.exec(this.text.slice(this.cursor))?.[0].length ?? 0;
    return boundary(this.text, this.cursor + length);
  }

  private remove(from: number, to: number): void {
    if (from === to) return;
    this.replace(this.text.slice(0, from) + this.text.slice(to), from);
    this.cursor = boundary(this.text, this.cursor);
  }

  private insert(value: string): void {
    const text = cleanInput(value);
    if (!text) return;
    const end = this.cursor + text.length;
    this.replace(this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor), end);
    const start = boundary(this.text, end);
    if (start < end) this.cursor = this.nextBoundary();
  }

  private replace(text: string, cursor = text.length): void {
    this.assign(text, cursor);
    this.historyIndex = this.history.length;
    this.parkedDraft = '';
  }

  private assign(text: string, cursor = text.length): void {
    this.text = text;
    this.cursor = cursor;
    this.selected = 0;
    this.dismissed = false;
  }
}

export class TerminalEditor {
  private readonly buffer: EditorBuffer;
  private attached = false;
  private wasRaw = false;
  private wasFlowing = false;

  constructor(
    private readonly input: ReadStream,
    private readonly output: WriteStream,
    private readonly options: EditorOptions,
  ) {
    this.buffer = new EditorBuffer(options.commands);
  }

  start(): void {
    if (this.attached) return;
    this.wasRaw = this.input.isRaw;
    this.wasFlowing = this.input.readableFlowing === true;
    emitKeypressEvents(this.input);
    this.input.setRawMode(true);
    this.input.on('keypress', this.onKey);
    this.input.resume();
    this.output.write('\u001b[?2004h');
    this.attached = true;
  }

  stop(): void {
    if (!this.attached) return;
    this.attached = false;
    this.input.off('keypress', this.onKey);
    this.input.setRawMode(this.wasRaw);
    if (!this.wasFlowing) this.input.pause();
    this.output.write('\u001b[?2004l');
  }

  view(): EditorView {
    return this.buffer.view();
  }

  setBusy(busy: boolean): void {
    this.buffer.setBusy(busy);
    this.options.onChange();
  }

  private readonly onKey = (value: string | undefined, key: EditorKey): void => {
    const action = this.buffer.key(value, key);
    if (!action) return;
    switch (action.type) {
      case 'change':
        this.options.onChange();
        break;
      case 'cycle':
        this.options.onCycleMode(action.direction);
        this.options.onChange();
        break;
      case 'submit':
        this.options.onSubmit(action.text);
        this.options.onChange();
        break;
      case 'exit':
        this.options.onExit();
        break;
      case 'interrupt':
        this.options.onInterrupt?.();
        break;
    }
  };
}
