import { doctorSession } from '../doctor/index.js';
import { renderDoctor } from '../doctor/render.js';
import { serveGui } from '../gui/index.js';
import { runCli } from './app.js';
import { evaluationOperations } from './eval-operations.js';
import { marketOperations, startMarketWatcher } from './market-commands.js';
import { mcpOperations } from './mcp-commands.js';

process.exitCode = await runCli(process.argv.slice(2), {
  doctor(sessionId, options, terminal) {
    const report = doctorSession(options.stateDir, sessionId);
    if (terminal.json) terminal.printJson(report);
    else terminal.note(renderDoctor(report));
  },
  async gui(options) {
    const stop = startMarketWatcher(options);
    try {
      await serveGui(options, {
        market: marketOperations(options),
        evaluation: evaluationOperations(options),
        mcp: mcpOperations(options),
      });
    } finally {
      stop();
    }
  },
});
