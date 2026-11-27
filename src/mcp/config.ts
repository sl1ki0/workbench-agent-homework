import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

interface CommonConfig {
  id: string;
  allowReadOnly: Set<string>;
  timeoutMs: number;
}

export type ServerConfig = CommonConfig &
  (
    | { transport: 'stdio'; command: string; args: string[]; cwd: string }
    | { transport: 'http'; url: URL }
  );

const names = /^[A-Za-z0-9_-]+$/;

export function alias(server: string, tool: string): string | undefined {
  const name = `mcp_${server}_${tool}`;
  return names.test(tool) && name.length <= 64 ? name : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string' && !item.includes('\0'))
  );
}

export function readConfig(path: string): ServerConfig[] {
  return parseConfiguration(JSON.parse(readFileSync(path, 'utf8')), dirname(resolve(path)));
}

export function parseConfiguration(configuration: unknown, base: string): ServerConfig[] {
  const servers = asObject(asObject(configuration)?.servers);
  if (!servers) throw new Error('MCP configuration requires a servers object');
  return Object.entries(servers).map(([id, value]) => {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) {
      throw new Error(
        `Invalid MCP server ID ${JSON.stringify(id)}. Use lowercase letters, digits and hyphens.`,
      );
    }
    const server = asObject(value);
    const command = server?.command;
    const args = server?.args ?? [];
    const readOnly = server?.allowReadOnly;
    const timeoutMs = server?.timeoutMs ?? 3000;
    if (!strings(readOnly) || readOnly.some((name) => !alias(id, name))) {
      throw new Error(`MCP ${id} allowReadOnly must explicitly list valid tool names`);
    }
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120_000
    ) {
      throw new Error(`MCP ${id} timeoutMs must be an integer between 1 and 120000`);
    }
    const common = { id, allowReadOnly: new Set(readOnly), timeoutMs };
    if (server?.url !== undefined) {
      if (typeof server.url !== 'string' || command !== undefined) {
        throw new Error(`MCP ${id} requires a URL or executable configuration`);
      }
      const url = new URL(server.url);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      ) {
        throw new Error(
          `MCP ${id} requires an HTTPS URL or loopback HTTP URL without credentials or parameters`,
        );
      }
      return { ...common, transport: 'http', url };
    }
    if (
      typeof command !== 'string' ||
      command.includes('\0') ||
      (command !== 'node' && !isAbsolute(command))
    )
      throw new Error(`MCP ${id} command must be node or an absolute executable path`);
    if (!strings(args)) throw new Error(`MCP ${id} args must be an array of strings`);
    const cwd = server?.cwd ?? base;
    if (typeof cwd !== 'string' || cwd.includes('\0'))
      throw new Error(`Invalid MCP ${id} working directory`);
    return {
      ...common,
      transport: 'stdio',
      command: command === 'node' ? process.execPath : command,
      args,
      cwd: resolve(base, cwd),
    };
  });
}
