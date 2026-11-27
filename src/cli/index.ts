import { doctorSession } from '../doctor/index.js';
import { renderDoctor } from '../doctor/render.js';
import { openMcp } from '../mcp/index.js';
import { loadSkills } from '../skills/index.js';
import { ensureOutside, runCli } from './app.js';

process.exitCode = await runCli(process.argv.slice(2), {
  async open(options) {
    for (const directory of options.skillDirs)
      ensureOutside(options.workspace, directory, 'Каталог скиллов');
    if (options.mcpConfig) ensureOutside(options.workspace, options.mcpConfig, 'Конфигурация MCP');
    const skills = options.skillDirs.length ? loadSkills(options.skillDirs) : undefined;
    const mcp = options.mcpConfig ? await openMcp(options.mcpConfig) : undefined;
    return {
      tools: [...(skills?.tools ?? []), ...(mcp?.tools ?? [])],
      systemPrompt: skills?.systemPrompt,
      initialEvents: [...(skills?.initialEvents ?? []), ...(mcp?.initialEvents ?? [])],
      ...(mcp ? { dispose: () => mcp.dispose() } : {}),
    };
  },
  doctor(sessionId, options, terminal) {
    const report = doctorSession(options.stateDir, sessionId);
    if (terminal.json) terminal.printJson(report);
    else terminal.note(renderDoctor(report));
  },
});
