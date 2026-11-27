import { checkRows, table, type Check } from './markdown.js';

const headers = ['Ученик', 'Завершено', 'Минуты'];
const expected = [
  ['Анна', '2', '75'],
  ['Борис', '1', '25'],
  ['Вера', '0', '0'],
  ['Итого', '3', '100'],
];

export function checkProgress(content: Buffer): Check {
  const rows = table(content.toString('utf8'), headers);
  const last = rows?.at(-1);
  if (!rows || last?.[0] !== 'Итого') {
    return { pass: false, details: ['Ожидалась таблица с последней строкой «Итого».'] };
  }
  const sorted = [...rows.slice(0, -1)].sort((left, right) =>
    (left[0] ?? '').localeCompare(right[0] ?? '', 'ru'),
  );
  return checkRows([...sorted, last], expected);
}
