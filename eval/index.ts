import { resolve } from 'node:path';
import { scenarios } from './cases.js';
import { writeReport } from './report.js';
import { executeTrials } from './runner.js';

async function main(): Promise<void> {
  const [command, first, second, third, ...extra] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    console.log(
      [
        'Workbench eval',
        '  run [каталог]                           18 попыток с настроенной LLM',
        '  smoke <сценарий> <A|B> [каталог]         одна пробная попытка с LLM',
        '  report [каталог]                        сводка по сохранённым данным',
        `Сценарии: ${scenarios.map(({ id }) => id).join(', ')}`,
      ].join('\n'),
    );
    return;
  }
  if (command === 'smoke') {
    const scenario = scenarios.find(({ id }) => id === first);
    if (!scenario || (second !== 'A' && second !== 'B') || extra.length) {
      throw new Error('Ожидалось smoke <open-tasks|progress|no-skill> <A|B> [каталог].');
    }
    const output = resolve(third ?? '.agent/eval-smoke');
    await executeTrials(output, { scenario, variant: second });
    writeReport(output);
    return;
  }
  if (second || (command !== 'run' && command !== 'report')) {
    throw new Error('Ожидалось run [каталог] или report [каталог].');
  }
  const output = resolve(first ?? 'eval/evidence');
  if (command === 'run') await executeTrials(output);
  writeReport(output);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
