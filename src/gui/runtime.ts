import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { inventory } from '../cli/inventory.js';
import { projectMarketTools } from '../cli/market-commands.js';
import { projectMcp } from '../cli/mcp-commands.js';
import { changeSkillSelection, projectSkills } from '../cli/project-skills.js';
import type { CliOptions } from '../cli/options.js';
import { doctorSession } from '../doctor/index.js';
import { atomicJson, isMissing, withLock } from '../market/files.js';
import { readRegular } from '../market/registry.js';
import type { McpConnection } from '../mcp/index.js';
import { makeModel, readModelConfig } from '../model/index.js';
import { Agent } from '../runtime/index.js';
import type { AgentOptions, Decision, Run, StartOptions } from '../runtime/types.js';
import { readSkillSelection } from '../skills/index.js';
import type { AgentEvent, Model, ModelProgress } from '../types.js';
import { readPolicy, Workspace } from '../workspace/index.js';
import type { FileChange } from '../workspace/index.js';

export type GuiOperations = Record<
  string,
  (input: Record<string, unknown>) => unknown | Promise<unknown>
>;

export interface GuiExtensions {
  market?: GuiOperations;
  evaluation?: GuiOperations;
  mcp?: GuiOperations;
  model?: Model;
  port?: number;
  agentOptions?: Partial<AgentOptions>;
}

export type Activity =
  { type: 'event'; event: AgentEvent } | { type: 'progress'; progress: ModelProgress };

const fileLimit = 96_000;
const effortLevels = ['default', 'off', 'low', 'medium', 'high'] as const;
type EffortLevel = (typeof effortLevels)[number];

interface GuiPreferences {
  model?: string;
  effort: EffortLevel;
}

export class InputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function requiredString(value: unknown, label: string, max = 80): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new InputError(`Укажите ${label}`);
  return value;
}

export function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InputError('Ожидался JSON-объект');
  return value as Record<string, unknown>;
}

function updatePreferences(input: unknown, previous: GuiPreferences): GuiPreferences {
  const { model, effort } = objectValue(input);
  if (
    model !== undefined &&
    (typeof model !== 'string' || model.length > 160 || /[\u0000-\u001F]/u.test(model))
  )
    throw new InputError('Некорректное имя модели');
  if (effort !== undefined && !effortLevels.includes(effort as EffortLevel))
    throw new InputError('Некорректный режим thinking');
  return {
    model: typeof model === 'string' ? model.trim() || undefined : previous.model,
    effort: effort === undefined ? previous.effort : (effort as EffortLevel),
  };
}

function readPreferences(path: string): GuiPreferences {
  const defaults = { effort: 'default' } as const;
  try {
    const saved: unknown = JSON.parse(readRegular(path, 4096).toString('utf8'));
    return updatePreferences(saved, defaults);
  } catch (error) {
    if (isMissing(error)) return defaults;
    throw new InputError('Не удалось загрузить настройки модели из каталога состояния', 500);
  }
}

function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) return path;
  return join(canonical(parent), basename(path));
}

function requireOutside(root: string, candidate: string): void {
  const path = relative(root, canonical(candidate));
  if (!path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))) {
    throw new InputError('Файлы конфигурации и состояния должны находиться вне workspace');
  }
}

export function publicRun(run: Run) {
  return {
    id: run.id,
    sessionId: run.sessionId,
    createdAt: run.createdAt,
    status: run.status,
    mode: run.mode,
    phase: run.phase,
    prompt: run.messages.find((message) => message.role === 'user')?.content,
    final: run.final,
    error: run.error,
    pending: run.pending
      ? {
          tool: run.pending.call.function.name,
          args: Object.fromEntries(
            Object.entries(run.pending.args).map(([key, value]) => [
              key,
              key === 'content' && typeof value === 'string'
                ? `<${Buffer.byteLength(value)} байт>`
                : value,
            ]),
          ),
          stage: run.pending.stage,
          changedPaths: run.pending.changes?.map(({ path }) => path) ?? [],
        }
      : undefined,
    plan: run.plan,
    tasks: run.tasks.map(({ evidence, ...task }) => ({ ...task, verified: Boolean(evidence) })),
    spent: run.spent,
    limits: run.limits,
    usage: run.usage,
    changeCount: run.changes.length,
    rolledBack: run.rolledBack,
  };
}

function patch(change: FileChange) {
  const { path, before, after } = change;
  const oldBuffer = Buffer.from(before?.content ?? '', 'base64');
  const newBuffer = Buffer.from(after?.content ?? '', 'base64');
  const binary = oldBuffer.includes(0) || newBuffer.includes(0);
  const output = binary
    ? 'Двоичный файл'
    : createTwoFilesPatch(
        before ? `a/${path}` : '/dev/null',
        after ? `b/${path}` : '/dev/null',
        oldBuffer.toString('utf8'),
        newBuffer.toString('utf8'),
      );
  return {
    path,
    before: before?.hash,
    after: after?.hash,
    text: output.slice(0, fileLimit),
    truncated: output.length > fileLimit,
  };
}

export class GuiRuntime {
  private readonly preferencesFile: string;
  private busy = false;
  private connection?: McpConnection;
  private constructor(
    readonly options: CliOptions,
    readonly extensions: GuiExtensions,
    readonly workspace: Workspace,
  ) {
    this.preferencesFile = join(options.stateDir, 'gui-settings.json');
  }

  static async create(options: CliOptions, extensions: GuiExtensions): Promise<GuiRuntime> {
    const root = realpathSync(options.workspace);
    for (const path of [
      options.policy,
      options.stateDir,
      ...options.skillDirs,
      options.mcpConfig,
      options.envFile,
      options.marketConfig,
    ]) {
      if (path) requireOutside(root, path);
    }
    const policy = readPolicy(options.policy);
    policy.directories.deny = [...new Set([...policy.directories.deny, '.agent'])];
    const workspace = new Workspace(root, policy);
    const runtime = new GuiRuntime(options, extensions, workspace);
    try {
      await runtime.refreshConnections();
      runtime.agent();
      return runtime;
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }

  async dispose() {
    const connection = this.connection;
    this.connection = undefined;
    await connection?.dispose();
  }

  private async refreshConnections() {
    await this.dispose();
    this.connection = await projectMcp(this.options)?.connect();
  }

  async refreshAfterMcpChange() {
    if (!this.busy) await this.exclusively(() => this.refreshConnections());
  }

  inventory() {
    const skills = projectSkills(this.options);
    const selection = readSkillSelection(this.options.stateDir);
    return {
      ...inventory(
        [...(skills?.initialEvents ?? []), ...(this.connection?.initialEvents ?? [])],
        Boolean(skills) && selection.enabled,
        Boolean(this.options.mcpConfig),
      ),
      catalog: skills?.catalog ?? [],
      selectionEnabled: skills ? selection.enabled : undefined,
    };
  }

  skillsUpdate(input: unknown) {
    const { skill, enabled } = objectValue(input);
    if (typeof enabled !== 'boolean') throw new InputError('Укажите, включён ли скилл');
    if (skill === undefined) changeSkillSelection(this.options, enabled ? 'on' : 'off');
    else
      changeSkillSelection(
        this.options,
        enabled ? 'enable' : 'disable',
        requiredString(skill, 'имя скилла'),
      );
    return this.inventory();
  }

  private environment(preferences: GuiPreferences): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...(preferences.model ? { OPENAI_MODEL: preferences.model } : {}),
      ...(preferences.effort !== 'default'
        ? { OPENAI_REASONING_EFFORT: preferences.effort === 'off' ? 'none' : preferences.effort }
        : {}),
    };
  }

  private agent(onActivity?: (activity: Activity) => void, run?: Run): Agent {
    const env = onActivity ? this.environment(readPreferences(this.preferencesFile)) : process.env;
    const skills = onActivity ? projectSkills(this.options, run) : undefined;
    let client: Model | undefined;
    const model: Model = {
      complete: (messages, tools) => {
        client ??= this.extensions.model ?? makeModel(env);
        return client.complete(
          messages,
          tools,
          onActivity ? (progress) => onActivity({ type: 'progress', progress }) : undefined,
        );
      },
    };
    return new Agent({
      ...this.extensions.agentOptions,
      workspace: this.workspace,
      stateDir: this.options.stateDir,
      model,
      tools: [
        ...(skills?.tools ?? []),
        ...(skills
          ? projectMarketTools(
              this.options,
              skills.catalog.map(({ name }) => name),
            )
          : []),
        ...(this.connection?.tools ?? []),
        ...(this.extensions.agentOptions?.tools ?? []),
      ],
      systemPrompt: skills?.systemPrompt,
      initialEvents: [...(skills?.initialEvents ?? []), ...(this.connection?.initialEvents ?? [])],
      onEvent: (event) => {
        onActivity?.({ type: 'event', event });
        this.extensions.agentOptions?.onEvent?.(event);
      },
    });
  }

  settings(preferences = readPreferences(this.preferencesFile)) {
    const { provider, model, reasoningEffort, temperature, maxTokens } = readModelConfig(
      this.environment(preferences),
    );
    return {
      provider,
      model,
      reasoningEffort,
      temperature,
      maxTokens,
      effort: preferences.effort,
      defaultModel: process.env.OPENAI_MODEL?.trim() || (provider === 'ollama' ? 'qwen3:4b' : ''),
    };
  }

  settingsUpdate(input: unknown) {
    return withLock(`${this.preferencesFile}.lock`, () => {
      const preferences = updatePreferences(input, readPreferences(this.preferencesFile));
      const validated = this.settings(preferences);
      atomicJson(this.preferencesFile, preferences);
      return validated;
    });
  }

  bootstrap() {
    const settings = this.safeSettings();
    return {
      workspace: basename(this.workspace.root),
      settings,
      inventory: this.inventory(),
      mode: this.options.plan ? 'plan' : this.options.mode,
      sessionId: this.options.session,
      operations: {
        market: Object.keys(this.extensions.market ?? {}),
        evaluation: Object.keys(this.extensions.evaluation ?? {}),
        mcp: Object.keys(this.extensions.mcp ?? {}),
      },
      sessions: this.sessions(),
    };
  }

  private safeSettings() {
    try {
      return this.settings();
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  sessions() {
    const grouped = new Map<
      string,
      { id: string; title: string; updatedAt: string; status: string; count: number }
    >();
    const agent = this.agent();
    for (const filename of readdirSync(join(this.options.stateDir, 'runs'))) {
      if (!filename.endsWith('.json')) continue;
      let run: Run;
      try {
        run = agent.get(filename.slice(0, -5));
      } catch {
        continue;
      }
      const existing = grouped.get(run.sessionId);
      if (!existing || existing.updatedAt < run.createdAt) {
        grouped.set(run.sessionId, {
          id: run.sessionId,
          title: (
            run.messages.find((message) => message.role === 'user')?.content ?? 'Сессия'
          ).slice(0, 106),
          updatedAt: run.createdAt,
          status: run.status,
          count: (existing?.count ?? 0) + 1,
        });
      } else existing.count++;
    }
    return [...grouped.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  session(id: string) {
    const agent = this.agent();
    return { runs: agent.sessionRuns(id).map(publicRun), stats: agent.stats(id) };
  }

  logs(id: string) {
    return this.agent().get(id).events;
  }

  diff(id: string) {
    return this.agent().diff(id).map(patch);
  }

  doctor(id: string) {
    // A shared state directory may contain runs from multiple workspaces.
    if (!this.agent().sessionRuns(id).length) throw new InputError('Сессия не найдена', 404);
    return doctorSession(this.options.stateDir, id);
  }

  listFiles() {
    const files: string[] = [];
    for (const file of this.workspace.paths('.')) {
      if (files.length >= 300) return { files, truncated: true };
      files.push(file);
    }
    return { files, truncated: false };
  }

  file(path: string) {
    return { path, ...this.workspace.read(path, fileLimit) };
  }

  private async exclusively<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new InputError('Дождитесь текущего действия', 409);
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }

  begin(input: unknown, onActivity: (activity: Activity) => void) {
    const data = objectValue(input);
    const prompt = requiredString(data.prompt, 'текст задачи', 50_000);
    const mode = data.mode ?? 'safe';
    if (!['plan', 'safe', 'auto'].includes(String(mode))) throw new InputError('Неизвестный режим');
    const args: StartOptions = {
      prompt,
      mode: mode === 'auto' ? 'auto' : 'safe',
      plan: mode === 'plan',
      limits: this.options.limits,
      ...(data.sessionId ? { sessionId: requiredString(data.sessionId, 'ID сессии') } : {}),
    };
    return this.exclusively(async () => {
      await this.refreshConnections();
      return publicRun(await this.agent(onActivity).start(args));
    });
  }

  resume(input: unknown, onActivity: (activity: Activity) => void) {
    const data = objectValue(input);
    const id = requiredString(data.runId, 'ID запуска');
    const action = data.decision;
    if (
      action !== undefined &&
      !['approve', 'deny', 'retry', 'skip', 'abort'].includes(String(action))
    )
      throw new InputError('Неизвестное решение');
    const recovery =
      typeof data.attributeChanges === 'boolean'
        ? { attributeChanges: data.attributeChanges }
        : undefined;
    return this.exclusively(async () => {
      await this.refreshConnections();
      const saved = this.agent().get(id);
      return publicRun(
        await this.agent(onActivity, saved).resume(id, action as Decision | undefined, recovery),
      );
    });
  }

  rollback(input: unknown) {
    const id = requiredString(objectValue(input).runId, 'ID запуска');
    return this.exclusively(async () => ({
      changes: (await this.agent().rollback(id)).map(patch),
    }));
  }
}
