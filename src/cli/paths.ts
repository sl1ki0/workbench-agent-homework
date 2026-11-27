import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const installationRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export const defaultEnvPath = join(installationRoot, '.env');

interface StateEnvironment {
  XDG_STATE_HOME?: string;
}

interface PathOptions {
  workspace?: string;
  policy?: string;
  stateDir?: string;
  skillDirs?: string[];
  noSkills?: boolean;
  mcpConfig?: string;
  noMcp?: boolean;
  marketConfig?: string;
  envFile?: string;
}

function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(canonical(parent), relative(parent, path));
}

function outside(root: string, path: string): boolean {
  const fromRoot = relative(root, canonical(path));
  return isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`);
}

function workspaceState(workspace: string, env: StateEnvironment): string {
  const key = createHash('sha256').update(workspace).digest('hex').slice(0, 24);
  const home = homedir();
  const xdg = env.XDG_STATE_HOME;
  const homeState = join(home, '.local', 'state');
  const temporary = join(tmpdir(), `workbench-agent-${process.getuid?.() ?? 'user'}`);
  const candidates = [
    join(xdg && isAbsolute(xdg) ? xdg : homeState, 'workbench-agent', 'projects', key),
    join(homeState, 'workbench-agent', 'projects', key),
    join(temporary, 'projects', key),
  ];
  // Runtime reports the containment error when every destination lies inside the workspace.
  return candidates.find((path) => outside(workspace, path)) ?? join(temporary, 'projects', key);
}

export function resolvePaths(
  options: PathOptions,
  cwd = process.cwd(),
  env: StateEnvironment = process.env,
) {
  const caller = canonical(resolve(cwd));
  const repo = canonical(installationRoot);
  const demoWorkspace = canonical(join(repo, 'workspace'));
  const workspace = options.workspace
    ? resolve(caller, options.workspace)
    : caller === repo
      ? demoWorkspace
      : caller;
  const workspaceRoot = canonical(workspace);
  const localState = join(repo, '.agent');
  const useLocalState =
    caller === repo && outside(workspaceRoot, localState) && workspaceRoot === demoWorkspace;
  return {
    workspace,
    policy: options.policy ? resolve(caller, options.policy) : join(repo, 'config', 'policy.json'),
    stateDir: options.stateDir
      ? resolve(caller, options.stateDir)
      : useLocalState
        ? localState
        : workspaceState(workspaceRoot, env),
    skillDirs: options.noSkills
      ? []
      : (options.skillDirs?.map((path) => resolve(caller, path)) ?? [join(repo, 'skills')]),
    projectSkillDirs: options.noSkills ? [] : [join(workspaceRoot, '.agent')],
    mcpConfig: options.noMcp
      ? undefined
      : options.mcpConfig
        ? resolve(caller, options.mcpConfig)
        : join(repo, 'config', 'mcp.json'),
    marketConfig: options.marketConfig
      ? resolve(caller, options.marketConfig)
      : join(repo, 'market-fixtures', 'config.json'),
    envFile: options.envFile ? resolve(caller, options.envFile) : defaultEnvPath,
    explicitEnvFile: options.envFile !== undefined,
  };
}
