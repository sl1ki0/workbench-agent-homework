import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Check } from './markdown.js';

export function checkCopy(content: Buffer): Check {
  const original = readFileSync(join(process.cwd(), 'eval/fixtures/no-skill/note.txt'));
  return content.equals(original)
    ? { pass: true, details: [`Содержимое совпало побайтно (${original.length} байт).`] }
    : {
        pass: false,
        details: [`Байты отличаются (получено ${content.length}, эталон ${original.length}).`],
      };
}
