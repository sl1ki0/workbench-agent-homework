import { McpManager, searchMcpRegistry } from '../mcp/manager.js';
import type { Terminal } from './format.js';
import type { CliOptions } from './options.js';

export function projectMcp(options: CliOptions): McpManager | undefined {
  return options.mcpConfig ? new McpManager(options.mcpConfig, options.stateDir) : undefined;
}

export function mcpOperations(options: CliOptions) {
  const manager = projectMcp(options);
  function enabled() {
    if (!manager) throw new Error('MCP отключён флагом --no-mcp');
    return manager;
  }
  async function status() {
    return { servers: await enabled().status() };
  }
  function values(input: unknown): Record<string, unknown> {
    return input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  }
  return {
    list: status,
    test: status,
    async search(input: unknown) {
      return { entries: await searchMcpRegistry(String(values(input).query ?? '')) };
    },
    add(input: unknown) {
      const { id, config } = values(input);
      enabled().add(String(id ?? ''), config, process.cwd());
      return { id, saved: true };
    },
    remove(input: unknown) {
      const { id } = values(input);
      enabled().remove(String(id ?? ''));
      return { id, removed: true };
    },
  };
}

export async function runMcpCommand(args: string[], options: CliOptions, terminal: Terminal) {
  const [command = 'list', target, ...rest] = args;
  const operations = mcpOperations(options);
  if (command === 'list' || command === 'test') {
    const result = await operations[command]();
    if (terminal.json) terminal.printJson(result);
    else if (!result.servers.length) terminal.note('MCP · серверов нет');
    else
      for (const entry of result.servers) {
        const data = entry as Record<string, unknown>;
        terminal.note(
          `${entry.status === 'connected' ? '✓' : '×'} ${String(data.server)} · ${String(data.transport ?? '')} · ${String(data.error ?? (Array.isArray(data.tools) ? data.tools.join(', ') : ''))}`,
        );
      }
  } else if (command === 'search') {
    const result = await operations.search({ query: [target, ...rest].filter(Boolean).join(' ') });
    if (terminal.json) terminal.printJson(result);
    else if (!result.entries.length) terminal.note('В официальном реестре нет совпадений.');
    else
      for (const entry of result.entries) {
        terminal.note(
          `${entry.name} · ${entry.version}\n  ${entry.description}${entry.urls.length ? '\n  ' + entry.urls.join('\n  ') : ''}`,
        );
      }
  } else if (command === 'add' || command === 'remove') {
    if (!target) throw new Error('Укажите ID MCP-сервера');
    const result =
      command === 'add'
        ? operations.add({ id: target, config: JSON.parse(rest.join(' ')) })
        : operations.remove({ id: target });
    if (terminal.json) terminal.printJson(result);
    else terminal.note(`MCP · ${target} · ${command === 'add' ? 'настроен' : 'удалён'}`);
  } else {
    throw new Error('mcp list|test|search QUERY|add ID JSON|remove ID');
  }
}
