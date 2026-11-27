import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { defaultEnvPath } from '../src/cli/paths.js';
import { resolve } from 'node:path';
import { extendedScenarios } from './cases.js';
import { writeReport } from './report.js';
import { executeTrials } from './runner.js';

async function main(): Promise<void> {
  const [command, first, second, third, ...extra] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    console.log(
      [
        'Workbench eval',
        '  run [каталог]                           18 попыток с настроенной LLM',
        '  extended [каталог]                      30 попыток по расширенному набору',
        '  smoke <сценарий> <A|B> [каталог]         одна пробная попытка с LLM',
        '  report [каталог]                        сводка по сохранённым данным',
        `Сценарии: ${extendedScenarios.map(({ id }) => id).join(', ')}`,
      ].join('\n'),
    );
    return;
  }
  if (command !== 'report' && existsSync(defaultEnvPath)) loadEnvFile(defaultEnvPath);
  if (command === 'smoke') {
    const scenario = extendedScenarios.find(({ id }) => id === first);
    if (!scenario || (second !== 'A' && second !== 'B') || extra.length) {
      throw new Error('Ожидалось smoke <сценарий> <A|B> [каталог].');
    }
    const output = resolve(third ?? '.agent/eval-smoke');
    await executeTrials(output, { scenario, variant: second });
    writeReport(output);
    return;
  }
  if (second || !['run', 'extended', 'report'].includes(command)) {
    throw new Error('Ожидалось run, extended или report [каталог].');
  }
  const output = resolve(first ?? 'eval/evidence');
  if (command !== 'report') {
    await executeTrials(output, undefined, undefined, {
      suite: command === 'extended' ? extendedScenarios : undefined,
    });
  }
  writeReport(output);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
