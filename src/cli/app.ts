import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { loadEnvFile } from 'node:process';
import { createInterface } from 'node:readline';
import { makeModel, readModelConfig } from '../model/index.js';
import { Agent } from '../runtime/index.js';
import type { AgentEvent, Model, ToolDefinition } from '../types.js';
import { Workspace, readPolicy } from '../workspace/index.js';
import { Terminal, type CliRun } from './format.js';
import {
  parseAttribution,
  parseDecision,
  parseOptions,
  type CliOptions,
  type Decision,
} from './options.js';

export interface CliRuntimeExtension {
  tools?: ToolDefinition[];
  systemPrompt?: string;
  initialEvents?: Pick<AgentEvent, 'type' | 'data'>[];
  onEvent?(event: AgentEvent): void;
  dispose?(): Promise<void> | void;
}

interface CliExtensions {
  open?(options: CliOptions): Promise<CliRuntimeExtension>;
  doctor?(sessionId: string, options: CliOptions, terminal: Terminal): Promise<void> | void;
}

const commands = new Set(['chat', 'start', 'resume', 'stats', 'tasks', 'diff', 'rollback']);
const decisions = new Set(['approve', 'deny', 'retry', 'skip', 'abort']);

function canonicalLocation(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) return path;
  return resolve(canonicalLocation(parent), relative(parent, path));
}

export function ensureOutside(root: string, path: string, name: string) {
  const fromRoot = relative(realpathSync(root), canonicalLocation(path));
  if (
    !fromRoot ||
    (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
  ) {
    throw new Error(`${name} должен находиться вне workspace`);
  }
}

function required(value: string | undefined, help: string): string {
  if (!value) throw new Error(help);
  return value;
}

function requireId(rest: string[], command: string, kind = 'RUN_ID'): string {
  if (rest.length !== 1) throw new Error(`Команда ${command} принимает один ${kind}`);
  return required(rest[0], `Укажите ${kind}`);
}

function isPending(run: CliRun) {
  return ['awaiting_confirmation', 'awaiting_plan', 'uncertain'].includes(run.status);
}

function successCode(run: CliRun) {
  return run.status === 'failed' || run.status === 'budget_exhausted' ? 1 : 0;
}

function pendingHelp(run: CliRun): string {
  if (run.status === 'uncertain') {
    return run.pending?.changes?.length
      ? 'Укажите принадлежность изменений явно · /retry yes|no · /skip yes|no · /abort yes|no'
      : 'Выберите действие · /retry · /skip · /abort';
  }
  return 'Выберите действие · /approve · /deny';
}

function startArgs(prompt: string, options: CliOptions, sessionId = options.session) {
  return {
    prompt,
    mode: options.mode,
    plan: options.plan,
    limits: options.limits,
    ...(sessionId ? { sessionId } : {}),
  };
}

async function resumeRun(agent: Agent, id: string, decision?: Decision, attribute?: boolean) {
  return await agent.resume(
    id,
    decision,
    attribute === undefined ? undefined : { attributeChanges: attribute },
  );
}

async function chat(
  agent: Agent,
  options: CliOptions,
  terminal: Terminal,
  extensions: CliExtensions,
) {
  let mode = options.mode;
  let plan = options.plan;
  let sessionId = options.session;
  let current: CliRun | undefined;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const lines = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactive,
  });

  function prompt() {
    if (!interactive) return;
    lines.setPrompt(terminal.accent(current && isPending(current) ? 'решение ❯ ' : 'вы ❯ '));
    lines.prompt();
  }

  function show(run: CliRun) {
    current = run;
    sessionId = run.sessionId;
    terminal.run(run);
    if (isPending(run)) terminal.note(pendingHelp(run));
  }

  function selectSession(id: string | undefined) {
    sessionId = id;
    current = id ? agent.sessionRuns(id).at(-1) : undefined;
    if (current && isPending(current)) show(current);
    if (current?.status === 'running')
      terminal.note(`Продолжить прерванный запуск · /resume ${current.id}`);
  }

  if (!terminal.json) terminal.start(readModelConfig(), mode, sessionId);
  selectSession(sessionId);
  prompt();
  try {
    for await (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        prompt();
        continue;
      }
      if (line === '/exit' || line === '/quit') break;
      try {
        if (!line.startsWith('/')) {
          if (current && isPending(current)) throw new Error(pendingHelp(current));
          show(await agent.start(startArgs(line, { ...options, mode, plan }, sessionId)));
        } else {
          const [command, action, extra] = line.slice(1).split(/\s+/u);
          switch (command) {
            case 'help':
              terminal.note(
                `/stats · /tasks · /diff · /rollback RUN_ID · /resume RUN_ID\n/mode safe|auto · /plan on|off · /session SESSION_ID|new · /exit${extensions.doctor ? ' · /doctor' : ''}`,
              );
              break;
            case 'stats':
              terminal.stats(
                await agent.stats(
                  required(action ?? sessionId, 'Сначала начните диалог или укажите SESSION_ID.'),
                ),
              );
              break;
            case 'tasks':
              terminal.tasks(await agent.get(required(action ?? current?.id, 'Укажите RUN_ID.')));
              break;
            case 'diff':
              terminal.diff(await agent.diff(required(action ?? current?.id, 'Укажите RUN_ID.')));
              break;
            case 'rollback': {
              const id = required(action, 'Команда /rollback требует явный RUN_ID.');
              await agent.rollback(id);
              terminal.note(`Изменения запуска ${id} откатились.`);
              break;
            }
            case 'resume':
              show(await resumeRun(agent, required(action, 'Укажите RUN_ID.')));
              break;
            case 'doctor':
              if (!extensions.doctor) throw new Error('Команда /doctor недоступна');
              await extensions.doctor(
                required(action ?? sessionId, 'Укажите SESSION_ID.'),
                options,
                terminal,
              );
              break;
            case 'mode':
              if (action !== 'safe' && action !== 'auto') throw new Error('/mode safe|auto');
              mode = action;
              terminal.note(`Режим следующих запусков · ${mode}`);
              break;
            case 'plan':
              if (action !== 'on' && action !== 'off') throw new Error('/plan on|off');
              plan = action === 'on';
              terminal.note(`Планирование · ${plan ? 'включено' : 'выключено'}`);
              break;
            case 'session':
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
              show(
                await resumeRun(
                  agent,
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
      prompt();
    }
  } finally {
    lines.close();
  }
}

function loadEnvironment() {
  if (existsSync('.env')) loadEnvFile('.env');
}

export async function runCli(args: string[], extensions: CliExtensions = {}): Promise<number> {
  let terminal = new Terminal(false, false);
  let extension: CliRuntimeExtension | undefined;
  try {
    const options = parseOptions(args);
    const color = Boolean(
      process.stdout.isTTY &&
      process.env.TERM !== 'dumb' &&
      !('NO_COLOR' in process.env) &&
      !options.noColor,
    );
    terminal = new Terminal(color, options.json);
    if (options.help) {
      terminal.help(
        extensions.doctor ? ['  doctor SESSION_ID            Диагностика сохранённой сессии'] : [],
      );
      return 0;
    }
    const { command, rest } = options;
    if (command === 'doctor' && extensions.doctor) {
      await extensions.doctor(requireId(rest, command, 'SESSION_ID'), options, terminal);
      return 0;
    }
    if (!commands.has(command))
      throw new Error(`Неизвестная команда ${command}. Список команд · --help`);

    loadEnvironment();
    ensureOutside(options.workspace, options.policy, 'Файл policy');
    ensureOutside(options.workspace, options.stateDir, 'Каталог состояния');
    const workspace = new Workspace(options.workspace, await readPolicy(options.policy));
    const needsModel = command === 'chat' || command === 'start' || command === 'resume';
    if (needsModel) extension = await extensions.open?.(options);
    let client: Model | undefined;
    const model: Model = {
      complete(messages, tools) {
        client ??= makeModel();
        return client.complete(messages, tools);
      },
    };
    const agent = new Agent({
      workspace,
      stateDir: options.stateDir,
      model,
      ...(extension?.tools ? { tools: extension.tools } : {}),
      ...(extension?.systemPrompt ? { systemPrompt: extension.systemPrompt } : {}),
      ...(extension?.initialEvents ? { initialEvents: extension.initialEvents } : {}),
      onEvent(event) {
        terminal.event(event);
        extension?.onEvent?.(event);
      },
    });

    switch (command) {
      case 'chat':
        if (rest.length)
          throw new Error('Команда chat открывает диалог. Для одного запроса используйте start.');
        await chat(agent, options, terminal, extensions);
        break;
      case 'start': {
        const prompt = required(rest.join(' ').trim(), 'Укажите задачу после команды start.');
        const run = await agent.start(startArgs(prompt, options));
        terminal.run(run);
        if (isPending(run)) terminal.note(`Продолжить · resume ${run.id} --decision …`);
        return successCode(run);
      }
      case 'resume': {
        const run = await resumeRun(
          agent,
          requireId(rest, command),
          options.decision,
          options.attribute,
        );
        terminal.run(run);
        if (isPending(run)) terminal.note(pendingHelp(run));
        return successCode(run);
      }
      case 'stats':
        terminal.stats(await agent.stats(requireId(rest, command, 'SESSION_ID')));
        break;
      case 'tasks':
        terminal.tasks(await agent.get(requireId(rest, command)));
        break;
      case 'diff':
        terminal.diff(await agent.diff(requireId(rest, command)));
        break;
      case 'rollback': {
        const id = requireId(rest, command);
        const result = await agent.rollback(id);
        if (terminal.json) terminal.printJson(result ?? { run_id: id, rolled_back: true });
        else terminal.note(`Изменения запуска ${id} откатились.`);
        break;
      }
    }
    return 0;
  } catch (error) {
    terminal.error(error);
    return 1;
  } finally {
    await extension?.dispose?.();
  }
}
