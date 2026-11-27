import { createInterface } from 'node:readline';
import type { Agent } from '../runtime/index.js';
import { isPending, pendingHelp, required, resumeRun, startArgs } from './actions.js';
import { TerminalEditor, type CommandHint } from './editor.js';
import { Terminal, type CliRun } from './format.js';
import type { Inventory } from './inventory.js';
import { ModelControl } from './model-control.js';
import { parseAttribution, parseDecision, type CliOptions } from './options.js';
import { ChatScreen, level, type PermissionView } from './screen.js';

interface ChatHost {
  agent: Agent;
  options: CliOptions;
  terminal: Terminal;
  models: ModelControl;
  inventory: Inventory;
  onScreen?(screen?: ChatScreen): void;
  refreshSkills?(): void;
  skills?(action?: string, name?: string): void;
  mcp?(args: string[]): Promise<void>;
  market?(args: string[]): Promise<void>;
  evaluation?(args: string[]): void;
  doctor?(sessionId: string): Promise<void> | void;
}

const decisions = new Set(['approve', 'deny', 'retry', 'skip', 'abort']);
const permissions: PermissionView[] = ['Plan', 'Ask for edits', 'YOLO'];
const commands: CommandHint[] = [
  { name: '/status', description: 'Модель, скиллы и серверы MCP' },
  { name: '/stats', description: 'Расход и инструменты сессии' },
  { name: '/queue', description: 'Ожидающие сообщения · /queue clear' },
  { name: '/thinking', description: 'off · low · medium · high · default' },
  { name: '/skills', description: 'Список · on · off · enable NAME · disable NAME' },
  { name: '/mcp', description: 'list · test · add ID JSON · remove ID · search QUERY' },
  { name: '/market', description: 'Поиск, установка и обновление скиллов' },
  { name: '/eval', description: 'list · run base|extended · report ID' },
  { name: '/tasks', description: 'План и результаты задач' },
  { name: '/diff', description: 'Правки текущего запуска' },
  { name: '/doctor', description: 'Разбор журнала сессии' },
  { name: '/resume', description: 'Продолжить запуск по RUN_ID' },
  { name: '/rollback', description: 'Откатить правки по RUN_ID' },
  { name: '/session', description: 'SESSION_ID или new' },
  { name: '/mode', description: 'safe или auto' },
  { name: '/plan', description: 'on или off' },
  { name: '/help', description: 'Команды и клавиши' },
  { name: '/exit', description: 'Выйти из диалога' },
];
const choiceHints: CommandHint[] = [
  { name: '/approve', description: 'Разрешить действие или план' },
  { name: '/deny', description: 'Отклонить действие или план' },
];
const recoveryHints: CommandHint[] = [
  { name: '/retry', description: 'Повторить безопасный вызов' },
  { name: '/skip', description: 'Отметить вызов неуспешным' },
  { name: '/abort', description: 'Завершить запуск с ошибкой' },
];

function mcpArguments(line: string): string[] {
  return (
    /^\/mcp(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+([\s\S]+))?$/u
      .exec(line)
      ?.slice(1)
      .filter((arg): arg is string => Boolean(arg)) ?? []
  );
}

export async function chat(host: ChatHost): Promise<void> {
  const { options, terminal, models } = host;
  let mode = options.mode;
  let plan = options.plan;
  let sessionId = options.session;
  let current: CliRun | undefined;
  const queue: { text: string; mode: CliOptions['mode']; plan: boolean }[] = [];
  const fromTerminal = Boolean(
    process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb' && !terminal.json,
  );
  const screen = fromTerminal
    ? new ChatScreen(
        process.stdout,
        terminal,
        () => ({
          mode: permission(),
          settings: models.settings(),
          pending: current && isPending(current) ? pendingHelp(current) : undefined,
          queue: queue.map(({ text }) => text),
        }),
        host.inventory,
      )
    : undefined;

  function permission(): PermissionView {
    return plan ? 'Plan' : mode === 'auto' ? 'YOLO' : 'Ask for edits';
  }

  function cycle(direction: 1 | -1): void {
    const index = permissions.indexOf(permission());
    const next = permissions[(index + direction + permissions.length) % permissions.length];
    plan = next === 'Plan';
    mode = next === 'YOLO' ? 'auto' : 'safe';
    screen?.changed();
  }

  function show(run: CliRun): void {
    current = run;
    sessionId = run.sessionId;
    if (screen) screen.run(run);
    else {
      terminal.run(run);
      if (isPending(run)) terminal.note(pendingHelp(run));
    }
  }

  function selectSession(id: string | undefined): void {
    sessionId = id;
    current = id ? host.agent.sessionRuns(id).at(-1) : undefined;
    screen?.resetUsage(current);
    if (current && isPending(current)) show(current);
    if (current?.status === 'running') {
      terminal.note(`Продолжить прерванный запуск · /resume ${current.id}`);
    }
  }

  function hints(): CommandHint[] {
    const available = commands.filter(({ name }) => name !== '/doctor' || host.doctor);
    if (!current || !isPending(current)) return available;
    return [...(current.status === 'uncertain' ? recoveryHints : choiceHints), ...available];
  }

  function status(): void {
    if (screen) screen.showInventory();
    else
      terminal.note(
        `${models.settings().model} · ${permission()} · thinking ${level(models.settings().reasoningEffort)}`,
      );
  }

  async function handle(raw: string, runMode = { mode, plan }): Promise<boolean> {
    const line = raw.trim();
    if (!line) return true;
    if (line === '/exit' || line === '/quit') return false;
    try {
      if (!line.startsWith('/')) {
        if (current && isPending(current)) throw new Error(pendingHelp(current));
        host.refreshSkills?.();
        screen?.begin(line);
        show(await host.agent.start(startArgs(line, { ...options, ...runMode }, sessionId)));
      } else {
        const [command, action, extra] = line.slice(1).split(/\s+/u);
        switch (command) {
          case 'help':
            terminal.note(
              hints()
                .map(({ name, description }) => `${name}  ${description}`)
                .join('\n'),
            );
            if (screen)
              terminal.note('Tab / Shift+Tab · режим   Ctrl+U · очистить   Ctrl+J · новая строка');
            break;
          case 'status':
            status();
            break;
          case 'queue':
            if (action === 'clear' && !extra) {
              const count = queue.length;
              queue.length = 0;
              terminal.note(`Очередь очищена · снято ${count}`);
            } else if (!action) {
              terminal.note(
                queue.length
                  ? queue.map(({ text }, index) => `${index + 1}. ${text}`).join('\n')
                  : 'Очередь пуста.',
              );
            } else throw new Error('/queue или /queue clear');
            break;
          case 'thinking':
            if (action) models.setThinking(action);
            terminal.note(`Thinking · ${level(models.settings().reasoningEffort)}`);
            break;
          case 'skills':
            if (action && current && isPending(current)) throw new Error(pendingHelp(current));
            host.skills?.(action, extra);
            break;
          case 'mcp':
            if (current && isPending(current) && ['add', 'remove', 'test'].includes(action ?? ''))
              throw new Error(pendingHelp(current));
            await host.mcp?.(mcpArguments(line));
            break;
          case 'market':
            if (
              current &&
              isPending(current) &&
              !['list', 'search', 'news', 'updates'].includes(action ?? 'list')
            )
              throw new Error(pendingHelp(current));
            await host.market?.(
              line
                .replace(/^\/market\s*/u, '')
                .split(/\s+/u)
                .filter(Boolean),
            );
            break;
          case 'eval':
            host.evaluation?.(
              line
                .replace(/^\/eval\s*/u, '')
                .split(/\s+/u)
                .filter(Boolean),
            );
            break;
          case 'stats':
            terminal.stats(host.agent.stats(required(action ?? sessionId, 'Укажите SESSION_ID.')));
            break;
          case 'tasks':
            terminal.tasks(host.agent.get(required(action ?? current?.id, 'Укажите RUN_ID.')));
            break;
          case 'diff':
            terminal.diff(host.agent.diff(required(action ?? current?.id, 'Укажите RUN_ID.')));
            break;
          case 'rollback': {
            const id = required(action, 'Команда /rollback требует явный RUN_ID.');
            await host.agent.rollback(id);
            terminal.note(`Правки запуска ${id} откачены.`);
            break;
          }
          case 'resume': {
            const id = required(action, 'Укажите RUN_ID.');
            const savedRun = host.agent.get(id);
            if (queue.length && savedRun.sessionId !== sessionId) {
              throw new Error(
                'В очереди есть сообщения текущей сессии. Для смены сессии используйте /queue clear.',
              );
            }
            screen?.resetUsage(savedRun);
            show(await resumeRun(host.agent, id));
            break;
          }
          case 'doctor':
            if (!host.doctor) throw new Error('Команда /doctor недоступна');
            await host.doctor(required(action ?? sessionId, 'Укажите SESSION_ID.'));
            break;
          case 'mode':
            if (action !== 'safe' && action !== 'auto') throw new Error('/mode safe|auto');
            mode = action;
            terminal.note(`Режим следующих запусков · ${permission()}`);
            break;
          case 'plan':
            if (action !== 'on' && action !== 'off') throw new Error('/plan on|off');
            plan = action === 'on';
            terminal.note(`Режим следующих запусков · ${permission()}`);
            break;
          case 'session':
            if (queue.length)
              throw new Error(
                'В очереди есть сообщения. Для смены сессии используйте /queue clear.',
              );
            if (current && isPending(current)) throw new Error(pendingHelp(current));
            selectSession(
              action === 'new' ? undefined : required(action, '/session SESSION_ID|new'),
            );
            terminal.note(
              sessionId ? `Сессия ${sessionId}` : 'Следующая задача начнёт новую сессию.',
            );
            break;
          default:
            if (!command || !decisions.has(command))
              throw new Error('Неизвестная команда. Список команд · /help');
            if (!current || !isPending(current))
              throw new Error('В текущем запуске нет ожидающего решения.');
            if (extra) throw new Error('Укажите только yes или no после команды.');
            screen?.resetUsage(current);
            show(
              await resumeRun(
                host.agent,
                current.id,
                parseDecision(command),
                action ? parseAttribution(action) : undefined,
              ),
            );
        }
      }
    } catch (error) {
      terminal.error(error);
    }
    return true;
  }

  if (!screen) {
    if (!terminal.json) terminal.start(models.settings(), mode, sessionId);
    selectSession(sessionId);
    const lines = createInterface({ input: process.stdin, terminal: false });
    try {
      for await (const line of lines) if (!(await handle(line))) break;
    } finally {
      lines.close();
    }
    return;
  }

  const view = screen;
  host.onScreen?.(view);
  models.observe = view.progress;
  let editor: TerminalEditor | undefined;
  function dispose() {
    editor?.stop();
    view.close();
  }
  process.once('exit', dispose);
  try {
    await new Promise<void>((resolve, reject) => {
      let active = false;
      function requestExit(): void {
        if (active) terminal.note('Дождитесь завершения текущего запроса.');
        else if (queue.length)
          terminal.note('В очереди есть сообщения. Очистите её через /queue clear перед выходом.');
        else resolve();
      }

      function drain(): void {
        if (active || (current && (isPending(current) || current.status === 'running'))) return;
        const next = queue.shift();
        if (next) run(next.text, next);
      }

      function run(line: string, permission = { mode, plan }): void {
        active = true;
        editor?.setBusy(true);
        void handle(line, permission).then((keepOpen) => {
          active = false;
          view.settle();
          editor?.setBusy(false);
          if (keepOpen) drain();
          else requestExit();
        }, reject);
      }

      editor = new TerminalEditor(process.stdin, process.stdout, {
        commands: hints,
        onChange: view.changed,
        onCycleMode: cycle,
        onExit: requestExit,
        onInterrupt: requestExit,
        onSubmit(line) {
          if (!line.startsWith('/')) {
            queue.push({ text: line, mode, plan });
            drain();
          } else if (line === '/exit' || line === '/quit') {
            requestExit();
          } else if (/^\/queue(?:\s|$)/u.test(line)) {
            void handle(line).catch(reject);
          } else if (active) {
            terminal.note(
              'Команда доступна после текущего запроса. Очередь можно посмотреть через /queue.',
            );
          } else {
            run(line);
          }
        },
      });
      view.editor = editor;
      view.header();
      selectSession(sessionId);
      editor.start();
      view.changed();
    });
  } finally {
    process.off('exit', dispose);
    dispose();
    models.observe = undefined;
    host.onScreen?.(undefined);
  }
}
