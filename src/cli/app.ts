import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { loadEnvFile } from 'node:process';
import { Agent } from '../runtime/index.js';
import type { AgentEvent, ToolDefinition } from '../types.js';
import type { McpConnection } from '../mcp/index.js';
import { Workspace, readPolicy } from '../workspace/index.js';
import { Terminal, type CliRun } from './format.js';
import { isPending, pendingHelp, required, resumeRun, startArgs } from './actions.js';
import { chat } from './chat.js';
import { runEvaluationCommand } from './eval-operations.js';
import { inventory } from './inventory.js';
import { runMarketCommand, startMarketWatcher } from './market-commands.js';
import { projectMcp, runMcpCommand } from './mcp-commands.js';
import { ModelControl } from './model-control.js';
import { changeSkillSelection, projectSkills } from './project-skills.js';
import type { ChatScreen } from './screen.js';
import { parseOptions, type CliOptions } from './options.js';

export interface CliRuntimeExtension {
  tools?: ToolDefinition[];
  systemPrompt?: string;
  initialEvents?: Pick<AgentEvent, 'type' | 'data'>[];
  onEvent?(event: AgentEvent): void;
  dispose?(): Promise<void> | void;
}

interface CliExtensions {
  open?(options: CliOptions): Promise<CliRuntimeExtension>;
  gui?(options: CliOptions): Promise<void>;
  doctor?(sessionId: string, options: CliOptions, terminal: Terminal): Promise<void> | void;
}

const commands = new Set(['chat', 'start', 'resume', 'stats', 'tasks', 'diff', 'rollback']);
const extendedHelp = [
  '  skills [on|off|enable|disable] Каталог и настройки скиллов',
  '  mcp list|test|add|remove|search Подключения и официальный реестр MCP',
  '  market                          Поиск, установка и обновление скиллов',
  '  eval list|run|report             Запуски оценки и сводки',
  '  gui                              Локальный графический интерфейс',
];

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

function requireId(rest: string[], command: string, kind = 'RUN_ID'): string {
  if (rest.length !== 1) throw new Error(`Команда ${command} принимает один ${kind}`);
  return required(rest[0], `Укажите ${kind}`);
}

function successCode(run: CliRun) {
  return run.status === 'failed' || run.status === 'budget_exhausted' ? 1 : 0;
}

function loadEnvironment(options: CliOptions) {
  if (options.explicitEnvFile || existsSync(options.envFile)) {
    ensureOutside(options.workspace, options.envFile, 'Файл окружения');
    loadEnvFile(options.envFile);
  }
}

export function loadWorkspace(options: CliOptions): Workspace {
  ensureOutside(options.workspace, options.policy, 'Файл policy');
  ensureOutside(options.workspace, options.stateDir, 'Каталог состояния');
  const policy = readPolicy(options.policy);
  policy.directories.deny = [
    ...new Set([...policy.directories.deny, '.agent', '.env', '.env.local']),
  ];
  return new Workspace(options.workspace, policy);
}

function showSkills(
  options: CliOptions,
  terminal: Terminal,
  current = projectSkills(options),
): void {
  const catalog = current?.catalog ?? [];
  if (terminal.json) return terminal.printJson({ skills: catalog });
  if (!catalog.length) terminal.note('Skills · каталог пуст или отключён');
  else {
    for (const item of catalog) {
      terminal.note(
        `  ${item.enabled ? '●' : '○'} ${item.name} · ${item.enabled ? 'включён' : 'выключен'} · ≈ ${item.estimatedTokens} токенов`,
      );
    }
    terminal.note(
      'Размер полной инструкции оценён по UTF-8. Фактический расход показывает /stats.',
    );
  }
}

function protectConfiguration(options: CliOptions): void {
  ensureOutside(options.workspace, options.stateDir, 'Каталог состояния');
  for (const path of [...options.skillDirs, options.mcpConfig, options.marketConfig]) {
    if (path) ensureOutside(options.workspace, path, 'Конфигурация расширений');
  }
}

export async function runCli(args: string[], extensions: CliExtensions = {}): Promise<number> {
  let terminal = new Terminal(false, false);
  let extension: CliRuntimeExtension | undefined;
  let mcp: McpConnection | undefined;
  let stopMarket: (() => void) | undefined;
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
      terminal.help([
        ...(extensions.doctor
          ? ['  doctor SESSION_ID            Диагностика сохранённой сессии']
          : []),
        ...extendedHelp,
      ]);
      return 0;
    }
    const { command, rest } = options;
    if (command === 'doctor' && extensions.doctor) {
      await extensions.doctor(requireId(rest, command, 'SESSION_ID'), options, terminal);
      return 0;
    }
    loadEnvironment(options);
    protectConfiguration(options);
    if (command === 'gui' && extensions.gui) {
      if (rest.length) throw new Error('Команда gui не принимает позиционные аргументы');
      await extensions.gui(options);
      return 0;
    }
    if (command === 'market') return await runMarketCommand(rest, options, terminal);
    if (command === 'eval') return runEvaluationCommand(rest, options, terminal);
    if (command === 'mcp') {
      await runMcpCommand(rest, options, terminal);
      return 0;
    }
    if (command === 'skills') {
      if (rest[0]) changeSkillSelection(options, rest[0], rest[1]);
      showSkills(options, terminal);
      return 0;
    }
    if (!commands.has(command)) {
      throw new Error(`Неизвестная команда ${command}. Список команд · --help`);
    }

    const workspace = loadWorkspace(options);
    const needsModel = command === 'chat' || command === 'start' || command === 'resume';
    if (needsModel) {
      extension = await extensions.open?.(options);
      mcp = await projectMcp(options)?.connect();
    }
    const model = new ModelControl();
    const resources = inventory([], false, Boolean(options.mcpConfig));
    let screen: ChatScreen | undefined;
    let agent: Agent;
    let skills: ReturnType<typeof projectSkills>;
    function rebuild() {
      skills = needsModel ? projectSkills(options) : undefined;
      const extensionEvents = [
        ...(extension?.initialEvents ?? []),
        ...(mcp?.initialEvents ?? []),
        ...(skills?.initialEvents ?? []),
      ];
      Object.assign(
        resources,
        inventory(
          extensionEvents,
          options.skillDirs.length + options.projectSkillDirs.length > 0,
          Boolean(options.mcpConfig),
          skills?.catalog,
        ),
      );
      agent = new Agent({
        workspace,
        stateDir: options.stateDir,
        model,
        tools: [...(extension?.tools ?? []), ...(mcp?.tools ?? []), ...(skills?.tools ?? [])],
        systemPrompt: [extension?.systemPrompt, skills?.systemPrompt].filter(Boolean).join('\n'),
        initialEvents: extensionEvents,
        onEvent(event) {
          if (screen) screen.event(event);
          else terminal.event(event);
          extension?.onEvent?.(event);
        },
      });
      return agent;
    }
    agent = rebuild();

    switch (command) {
      case 'chat':
        if (rest.length)
          throw new Error('Команда chat открывает диалог. Для одного запроса используйте start.');
        stopMarket = startMarketWatcher(options, (message) => terminal.note(message));
        await chat({
          get agent() {
            return agent;
          },
          options,
          terminal,
          models: model,
          inventory: resources,
          onScreen(view) {
            screen = view;
          },
          doctor: extensions.doctor
            ? (id) => extensions.doctor?.(id, options, terminal)
            : undefined,
          refreshSkills: rebuild,
          skills(action, name) {
            if (action) {
              changeSkillSelection(options, action, name);
              rebuild();
            }
            showSkills(options, terminal, skills);
          },
          async mcp(args) {
            const action = args[0] ?? 'list';
            if (action !== 'test') await runMcpCommand(args, options, terminal);
            if (['test', 'add', 'remove'].includes(action)) {
              const next = await projectMcp(options)?.connect();
              await mcp?.dispose();
              mcp = next;
              rebuild();
              if (screen) screen.showInventory();
              else if (action === 'test') {
                for (const entry of next?.initialEvents ?? [])
                  terminal.event({
                    ...entry,
                    id: '',
                    time: '',
                    session_id: '',
                    run_id: '',
                  });
              }
            }
          },
          async market(args) {
            await runMarketCommand(args, options, terminal);
            rebuild();
          },
        });
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
    stopMarket?.();
    await Promise.all([extension?.dispose?.(), mcp?.dispose()]);
  }
}
