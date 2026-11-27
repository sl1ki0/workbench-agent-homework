import stringWidth from 'string-width';
import type { WriteStream } from 'node:tty';
import type { AgentEvent, ModelProgress, Usage } from '../types.js';
import type { ModelSettings } from '../model/index.js';
import { summarizeUsage } from '../runtime/stats.js';
import type { UsageSummary } from '../runtime/types.js';
import type { TerminalEditor } from './editor.js';
import { type CliRun, Terminal, terminalText } from './format.js';
import { Footer } from './footer.js';
import type { Inventory } from './inventory.js';

export type PermissionView = 'Plan' | 'Ask for edits' | 'YOLO';

interface ScreenState {
  mode: PermissionView;
  settings: ModelSettings;
  pending?: string;
  queue: readonly string[];
}

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const characters = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function wrap(value: string, width: number): string[] {
  const rows: string[] = [];
  let row = '';
  let columns = 0;
  for (const { segment } of characters.segment(value)) {
    const length = stringWidth(segment);
    if (segment === '\n' || (columns > 0 && columns + length > width)) {
      rows.push(row);
      row = '';
      columns = 0;
    }
    if (segment !== '\n') {
      row += segment;
      columns += length;
    }
  }
  rows.push(row);
  return rows;
}

function clipped(value: string, width: number): string {
  if (stringWidth(value) <= width) return value;
  return (wrap(value, Math.max(1, width - 1))[0] ?? '') + '…';
}

function metric(value: UsageSummary['input'] | undefined): string {
  if (!value || value.total === null) return '—';
  return String(value.total) + (value.status === 'partial' ? '+' : '');
}

function handles(event: AgentEvent): string {
  const { name, server, tool } = event.data;
  return server ? `${String(server)}/${String(tool)}` : String(name ?? '');
}

export class ChatScreen {
  private readonly footer = new Footer();
  private transcript: string[] = [];
  private queued?: NodeJS.Timeout;
  private ticker?: NodeJS.Timeout;
  private activity?: { label: string; started: number; thinking: boolean };
  private thinkingSeen = false;
  private started?: ReturnType<typeof performance.now>;
  private request = 0;
  private usage?: UsageSummary;
  private samples: Usage[] = [];
  private liveText = '';
  private committedText = '';
  private closed = false;
  editor?: TerminalEditor;

  constructor(
    private readonly stream: WriteStream,
    private readonly terminal: Terminal,
    private readonly state: () => ScreenState,
    private readonly inventory: Inventory,
  ) {
    stream.on('resize', this.changed);
    terminal.surface = this;
  }

  changed = () => {
    if (this.closed || this.queued) return;
    this.queued = setTimeout(() => {
      this.queued = undefined;
      this.paint();
    }, 24);
  };

  header(): void {
    this.writeLine(
      this.paintColor('1;36', '◈ Workbench') + '  /  ' + this.paintColor('2', 'Рабочая сессия'),
    );
    this.showInventory(false);
  }

  showInventory(expanded = true): void {
    const { settings, mode } = this.state();
    this.terminal.note(
      `${settings.model} · ${settings.provider} · ${mode} · thinking ${level(settings.reasoningEffort)}`,
    );
    const skills = this.inventory.skills;
    const servers = this.inventory.servers;
    this.terminal.note(
      `Skills · ${skills.length ? skills.join(', ') : this.inventory.skillsEnabled ? 'каталог пуст' : 'выключены'}` +
        (this.inventory.skillErrors ? ` · ошибок ${this.inventory.skillErrors}` : ''),
    );
    this.terminal.note(
      `MCP · ${servers.length ? servers.map((server) => `${server.error ? '×' : '✓'} ${server.name} (${server.tools.length})`).join(' · ') : this.inventory.mcpEnabled ? 'нет подключений' : 'выключен'}`,
    );
    if (expanded) {
      for (const server of servers) {
        this.terminal.note(`  ${server.name} · ${server.error ?? server.tools.join(', ')}`);
      }
    }
  }

  writeLine(value: string): void {
    this.transcript.push(value.replace(/\r?\n/gu, '\r\n') + '\r\n');
    this.changed();
  }

  begin(prompt: string): void {
    this.committedText = '';
    this.liveText = '';
    this.started = performance.now();
    this.request = 0;
    this.usage = undefined;
    this.samples = [];
    this.writeLine('');
    this.writeLine(this.paintColor('1;36', '▸ Вы') + '\r\n' + terminalText(prompt));
    this.setActivity('Готовлю запрос');
  }

  progress = (progress: ModelProgress) => {
    if (progress.type === 'thinking') {
      this.thinkingSeen = true;
      if (!this.liveText) this.setActivity('Thinking · модель обдумывает запрос', true);
    }
    if (progress.type === 'tool') this.setActivity('Модель выбирает инструмент');
    if (progress.type === 'text') {
      this.liveText += progress.text;
      this.setActivity('Пишет ответ');
    }
  };

  event(event: AgentEvent): void {
    const { type, data } = event;
    switch (type) {
      case 'run_started':
        this.started ??= performance.now();
        break;
      case 'model_request':
        this.thinkingSeen = false;
        this.request = Number(data.request) || 0;
        this.usage = summarizeUsage(this.samples, this.request);
        this.setActivity('Жду модель');
        break;
      case 'model_usage':
        this.finishThinking();
        if (data.usage && typeof data.usage === 'object') this.samples.push(data.usage as Usage);
        this.usage = summarizeUsage(this.samples, this.request);
        this.finishText();
        this.setActivity('Обрабатываю ответ');
        break;
      case 'model_error':
        this.finishThinking();
        this.finishText(false);
        break;
      case 'tool_started':
        this.setActivity(`Выполняю ${handles(event)}`);
        this.terminal.event(event);
        break;
      case 'tool_result':
      case 'tool_error':
        this.setActivity('Проверяю результат');
        this.terminal.event(event);
        break;
      case 'skills_discovered':
      case 'mcp_connected':
        break;
      case 'task_started':
        this.terminal.note(`  ▸ Задача ${String(data.task_id ?? '')}`);
        break;
      case 'task_completed':
        this.terminal.note(`  ✓ Задача ${String(data.task_id ?? '')} проверена`);
        break;
      default:
        this.terminal.event(event);
    }
  }

  run(run: CliRun): void {
    this.finishText();
    this.usage = run.usage;
    this.request = run.spent.modelCalls;
    const alreadyShown = this.committedText.trim() === (run.final ?? '').trim();
    this.terminal.run(run, { showUsage: false, showFinal: !alreadyShown });
    this.settle();
  }

  settle(): void {
    this.activity = undefined;
    this.started = undefined;
    clearInterval(this.ticker);
    this.ticker = undefined;
    this.changed();
  }

  resetUsage(run?: CliRun): void {
    this.usage = run?.usage;
    this.samples = [...(run?.usageSamples ?? [])];
    this.committedText = '';
    this.request = run?.spent.modelCalls ?? 0;
    this.changed();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.queued);
    clearInterval(this.ticker);
    this.stream.off('resize', this.changed);
    this.stream.write(this.footer.close(this.takeTranscript()));
    this.terminal.surface = undefined;
  }

  private finishText(commit = true): void {
    const value = this.liveText;
    this.liveText = '';
    if (!value.trim() || !commit) return;
    this.committedText = value;
    this.writeLine(this.paintColor('1;35', '◈ Ответ') + '\r\n' + terminalText(value.trim()));
  }

  private finishThinking(): void {
    if (!this.thinkingSeen) return;
    this.thinkingSeen = false;
    this.writeLine(this.paintColor('2;35', '  ◇ Thinking · сигнал от модели'));
  }

  private setActivity(label: string, thinking = false): void {
    this.started ??= performance.now();
    if (this.activity?.label !== label) {
      this.activity = { label, started: performance.now(), thinking };
    }
    this.ticker ??= setInterval(this.changed, 125).unref();
    this.changed();
  }

  private paintColor(code: string, text: string): string {
    return this.terminal.color ? '\x1b[' + code + 'm' + text + '\x1b[0m' : text;
  }

  private takeTranscript(): string {
    const value = this.transcript.join('');
    this.transcript = [];
    return value;
  }

  private paint(): void {
    if (this.closed || !this.editor) return;
    const width = Math.max(8, (this.stream.columns || 80) - 1);
    const height = this.stream.rows || 24;
    const view = this.editor.view();
    const state = this.state();
    const rows: string[] = [];
    const add = (value: string, color: string) =>
      rows.push(this.paintColor(color, clipped(value, width)));
    const showQueue = height >= 2 && state.queue.length > 0;
    const showActivity = height > (showQueue ? 2 : 1) && Boolean(this.activity || state.pending);
    const showStatus = height >= 7;
    const showLegend = height >= 10;
    const draft = terminalText(view.text).replaceAll('\t', '  ');
    const before = terminalText(view.text.slice(0, view.cursor)).replaceAll('\t', '  ');
    const promptWidth = Math.max(2, width - 2);
    const lines = wrap(draft, promptWidth);
    const prefix = wrap(before, promptWidth);
    const selected = prefix.length - 1;
    const reserved =
      Number(showQueue) + Number(showActivity) + (showStatus ? 4 : 0) + Number(showLegend);
    const cap = Math.max(1, Math.min(height < 12 ? 1 : 4, height - reserved));
    const spare = Math.max(0, height - reserved - Math.min(cap, lines.length));
    const suggestions = height >= 12 ? Math.min(4, view.suggestions.length, spare) : 0;
    if (showActivity && this.activity) {
      const now = performance.now();
      const tick = Math.floor((now - this.activity.started) / 125) % frames.length;
      const started = this.activity.thinking ? this.activity.started : (this.started ?? now);
      const elapsed = ((now - started) / 1000).toFixed(1) + ' с';
      add(
        `${frames[tick]} ${terminalText(this.activity.label)} · запрос ${this.request || '—'} · ${elapsed}`,
        this.activity.thinking ? '1;35' : '1;36',
      );
    } else if (showActivity && state.pending) add(state.pending, '1;33');
    if (this.liveText && height >= 13) {
      const limit = Math.min(5, Math.floor(height / 4), spare - suggestions);
      const answer = wrap(terminalText(this.liveText).replaceAll('\t', '  '), width - 2);
      for (const row of limit > 0 ? answer.slice(-limit) : []) add('  ' + row, '0');
    }

    if (showQueue) {
      const preview = terminalText(state.queue[0] ?? '').replace(/\s+/gu, ' ');
      add(`Очередь · ${state.queue.length} · ${preview}`, '1;33');
    }

    if (suggestions) {
      const offset = Math.max(0, view.selected - suggestions + 1);
      for (let i = offset; i < offset + suggestions; i += 1) {
        const hint = view.suggestions[i];
        if (hint)
          add(
            `${i === view.selected ? '›' : ' '} ${hint.name}   ${hint.description}`,
            i === view.selected ? '1;36' : '2',
          );
      }
    }

    if (showStatus) add('─'.repeat(width), '2;36');
    const offset = Math.max(0, selected - cap + 1);
    const cursorRow = rows.length + selected - offset;
    const cursorCol = Math.min(width - 1, 2 + stringWidth(prefix.at(-1) ?? ''));
    if (!draft) {
      add(
        state.pending
          ? '› Решение или /help'
          : view.busy
            ? '› Следующее сообщение'
            : '› Сообщение или /команда',
        '2',
      );
    } else {
      lines
        .slice(offset, offset + cap)
        .forEach((line, index) => add((index === 0 ? '› ' : '  ') + line, '0'));
    }
    if (showStatus) {
      add('─'.repeat(width), '2;36');
      const { settings, mode } = state;
      add(
        `[${mode}]  ${terminalText(settings.model)} · thinking ${level(settings.reasoningEffort)}`,
        '1;36',
      );
      add(
        `вход ${metric(this.usage?.input)} · выход ${metric(this.usage?.output)} · кэш ${metric(this.usage?.cached)} · запросы ${this.request}`,
        '2',
      );
    }
    if (showLegend)
      add(
        `Skills ${this.inventory.skills.length} · MCP ${this.inventory.servers.filter(({ error }) => !error).length}    Tab режим · Ctrl+U очистить · /help`,
        '2',
      );

    const output = this.footer.render(
      { rows, row: cursorRow, column: cursorCol, width, height },
      this.takeTranscript(),
    );
    if (output) this.stream.write(output);
  }
}

export function level(value?: string): string {
  return value === 'none' ? 'off' : (value ?? 'provider');
}
