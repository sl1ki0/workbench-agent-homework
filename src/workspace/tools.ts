import type { ToolDefinition } from '../types.js';
import { runBash } from './bash.js';
import type { Workspace } from './index.js';

const pathDescription = 'Path relative to the workspace. Use . for the workspace root.';

function strings(properties: Record<string, string>): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, description]) => [
        name,
        { type: 'string', description },
      ]),
    ),
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export function workspaceTools(workspace: Workspace): ToolDefinition[] {
  return [
    {
      name: 'list_files',
      description: 'List policy-authorized files recursively within a workspace directory.',
      schema: strings({ path: pathDescription }),
      sideEffect: false,
      safeRetry: true,
      authorize: (args) => void workspace.directory(args.path as string),
      execute: async (args, { maxBytes }) => {
        const path = args.path as string;
        workspace.directory(path);
        const files: string[] = [];
        let remaining = Math.max(0, maxBytes - Buffer.byteLength(JSON.stringify({ path, files })));
        for (const file of workspace.paths(path)) {
          remaining -= Buffer.byteLength(JSON.stringify(file)) + (files.length > 0 ? 1 : 0);
          if (remaining < 0) return { ok: true, output: { path, files }, truncated: true };
          files.push(file);
        }
        return { ok: true, output: { path, files } };
      },
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the workspace.',
      schema: strings({ path: pathDescription }),
      sideEffect: false,
      safeRetry: true,
      authorize: (args) => void workspace.file(args.path as string, 'read'),
      execute: async (args, { maxBytes }) => {
        const path = args.path as string;
        const { content, truncated } = workspace.read(path, maxBytes);
        return { ok: true, output: { path, content }, truncated };
      },
    },
    {
      name: 'write_file',
      description:
        'Create a text file or replace its full contents. The parent directory must exist.',
      schema: strings({ path: pathDescription, content: 'Full new UTF-8 file contents.' }),
      sideEffect: true,
      safeRetry: true,
      authorize: (args) => void workspace.file(args.path as string, 'write'),
      execute: async (args) => {
        const path = args.path as string;
        workspace.write(path, args.content as string);
        return {
          ok: true,
          output: { path, bytesWritten: Buffer.byteLength(args.content as string) },
        };
      },
    },
    {
      name: 'delete_file',
      description: 'Delete a workspace file. A missing file is already in the requested state.',
      schema: strings({ path: pathDescription }),
      sideEffect: true,
      safeRetry: true,
      authorize: (args) => void workspace.file(args.path as string, 'write'),
      execute: async (args) => {
        const path = args.path as string;
        return { ok: true, output: { path, deleted: workspace.delete(path) } };
      },
    },
    {
      name: 'Bash',
      description: `Run an exact, policy-allowed simple Bash command. Allowed commands: ${workspace.policy.commands.allow.filter((command) => !workspace.policy.commands.deny.includes(command)).join(', ')}.`,
      schema: strings({ command: 'An exact command from the allow-list.', cwd: pathDescription }),
      sideEffect: true,
      safeRetry: false,
      authorize: (args) => void workspace.bash(args.command as string, args.cwd as string),
      execute: async (args, { maxBytes }) => {
        const { tokens, cwd } = workspace.bash(args.command as string, args.cwd as string);
        return runBash(
          tokens,
          cwd,
          workspace.policy.bash?.timeoutMs ?? 15_000,
          Math.min(workspace.policy.bash?.maxOutputBytes ?? 65_536, maxBytes),
        );
      },
    },
  ];
}
