import { checkRows, table, type Check } from './markdown.js';

const headers = ['Ученик', 'Завершено', 'Минуты'];
const expected = [
  ['Анна', '2', '75'],
  ['Борис', '1', '25'],
  ['Вера', '0', '0'],
  ['Итого', '3', '100'],
];

function checkProgressRows(content: Buffer, expectedRows: string[][]): Check {
  const rows = table(content.toString('utf8'), headers);
  const last = rows?.at(-1);
  if (!rows || last?.[0] !== 'Итого') {
    return { pass: false, details: ['Ожидалась таблица с последней строкой «Итого».'] };
  }
  const sorted = [...rows.slice(0, -1)].sort((left, right) =>
    (left[0] ?? '').localeCompare(right[0] ?? '', 'ru'),
  );
  return checkRows([...sorted, last], expectedRows);
}

export function checkProgress(content: Buffer): Check {
  return checkProgressRows(content, expected);
}

export function checkAlternateProgress(content: Buffer): Check {
  const rows = checkProgressRows(content, [
    ['Анна', '1', '26'],
    ['Борис', '2', '14'],
    ['Вера', '0', '0'],
    ['Итого', '3', '40'],
  ]);
  const mentionsMissing = content
    .toString('utf8')
    .split(/\r?\n/u)
    .some((line) => {
      const text = line.toLowerCase();
      return (
        /\bl5\b/u.test(text) && /нет|пропущ|неизвест|отсутств|не указан|missing|unknown/u.test(text)
      );
    });
  return {
    pass: rows.pass && mentionsMissing,
    details: [...rows.details, mentionsMissing ? 'Пропуск L5 отмечен.' : 'Пропуск L5 не отмечен.'],
  };
}
