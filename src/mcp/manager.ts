import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseConfiguration } from './config.js';
import { openMcpConfiguration } from './index.js';

interface Override {
  additions: Record<string, unknown>;
  disabled: string[];
  inactive?: string[];
}
const knownId = /^[a-z][a-z0-9-]{0,30}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class McpManager {
  private readonly overridesFile: string;

  constructor(
    private readonly config: string,
    state: string,
  ) {
    const profile = createHash('sha256').update(resolve(config)).digest('hex').slice(0, 16);
    this.overridesFile = join(state, 'mcp', `${profile}.json`);
  }

  definitions() {
    return this.configured().filter(({ enabled }) => enabled);
  }

  configured() {
    const profile = this.readOverrides();
    return this.apply(profile).map((server) => ({
      ...server,
      enabled: !(profile.inactive ?? []).includes(server.id),
    }));
  }

  setEnabled(id: string, enabled: boolean): void {
    this.checkId(id);
    const profile = this.readOverrides();
    if (!this.apply(profile).some((server) => server.id === id)) {
      throw new Error(`Сервер ${id} не настроен`);
    }
    const inactive = new Set(profile.inactive);
    if (enabled) inactive.delete(id);
    else inactive.add(id);
    profile.inactive = [...inactive];
    this.save(profile);
  }

  private apply(profile: Override) {
    const base = record(record(JSON.parse(readFileSync(this.config, 'utf8')))?.servers);
    if (!base) throw new Error('MCP configuration requires a servers object');
    const servers = Object.fromEntries(
      Object.entries({ ...base, ...profile.additions }).filter(
        ([id]) => !profile.disabled.includes(id),
      ),
    );
    return parseConfiguration({ servers }, dirname(this.config));
  }

  connect() {
    return openMcpConfiguration(this.definitions());
  }

  async status() {
    const connection = await this.connect();
    try {
      return connection.initialEvents.map(({ type, data }) => ({
        ...data,
        status: type === 'mcp_connected' ? 'connected' : 'error',
      }));
    } finally {
      await connection.dispose();
    }
  }

  add(id: string, definition: unknown, cwd: string): void {
    this.checkId(id);
    if (this.configured().some((server) => server.id === id)) {
      throw new Error(`Сервер ${id} уже настроен. Удалите старую запись перед заменой.`);
    }
    const server = record(definition);
    if (!server) throw new Error('Конфигурация сервера должна быть JSON-объектом');
    const profile = this.readOverrides();
    const added = server.url ? server : { ...server, cwd: resolve(cwd, String(server.cwd ?? '.')) };
    profile.additions = { ...profile.additions, [id]: added };
    profile.disabled = profile.disabled.filter((item) => item !== id);
    profile.inactive = profile.inactive?.filter((item) => item !== id);
    this.apply(profile);
    this.save(profile);
  }

  remove(id: string): void {
    this.checkId(id);
    if (!this.configured().some((server) => server.id === id))
      throw new Error(`Сервер ${id} не настроен`);
    const profile = this.readOverrides();
    delete profile.additions[id];
    profile.inactive = profile.inactive?.filter((item) => item !== id);
    profile.disabled = [...new Set([...profile.disabled, id])];
    this.save(profile);
  }

  private checkId(id: string) {
    if (!knownId.test(id))
      throw new Error('ID сервера допускает строчные буквы ASCII, цифры и дефисы');
  }

  private readOverrides(): Override {
    try {
      return JSON.parse(readFileSync(this.overridesFile, 'utf8')) as Override;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { additions: {}, disabled: [] };
    }
  }

  private save(profile: Override) {
    mkdirSync(dirname(this.overridesFile), { mode: 0o700, recursive: true });
    const staging = `${this.overridesFile}.${randomUUID()}.tmp`;
    try {
      writeFileSync(staging, JSON.stringify(profile, null, 2), { flag: 'wx', mode: 0o600 });
      renameSync(staging, this.overridesFile);
    } finally {
      rmSync(staging, { force: true });
    }
  }
}

export async function searchMcpRegistry(query: string, request: typeof fetch = fetch) {
  const term = query.trim();
  if (!term || term.length > 120) throw new Error('Введите от 1 до 120 символов для поиска MCP');
  const url = new URL('https://registry.modelcontextprotocol.io/v0.1/servers');
  url.searchParams.set('search', term);
  url.searchParams.set('limit', '12');
  url.searchParams.set('version', 'latest');
  const response = await request(url, { signal: AbortSignal.timeout(8_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Официальный реестр MCP ответил HTTP ${response.status}`);
  const payload: unknown = await response.json();
  const servers = record(payload)?.servers;
  if (!Array.isArray(servers)) throw new Error('Реестр MCP вернул некорректный каталог');
  return servers.slice(0, 12).flatMap((candidate) => {
    const result = record(candidate);
    const status = record(
      record(result?._meta)?.['io.modelcontextprotocol.registry/official'],
    )?.status;
    const server = record(result?.server);
    if (!server || status === 'deleted' || typeof server.name !== 'string') return [];
    return [
      {
        name: server.name,
        description: typeof server.description === 'string' ? server.description.slice(0, 240) : '',
        version: typeof server.version === 'string' ? server.version : '',
        urls: Array.isArray(server.remotes)
          ? server.remotes.flatMap((remote) => {
              const data = record(remote);
              return data?.type === 'streamable-http' && typeof data.url === 'string'
                ? [data.url]
                : [];
            })
          : [],
      },
    ];
  });
}
