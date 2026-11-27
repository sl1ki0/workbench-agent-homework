export interface Check {
  pass: boolean;
  details: string[];
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim().replace(/^`([^`]+)`$|^\*\*([^*]+)\*\*$/u, '$1$2'));
}

export function table(content: string, headers: string[]): string[][] | null {
  const lines = content.split(/\r?\n/u);
  const tables: string[][][] = [];
  let fenced = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(?:```|~~~)/u.test(line)) fenced = !fenced;
    if (fenced || !line.includes('|')) continue;
    const head = splitRow(line);
    const separator = splitRow(lines[index + 1] ?? '');
    if (
      head.length !== headers.length ||
      !head.every((cell, i) => cell.toLowerCase() === headers[i]?.toLowerCase()) ||
      separator.length !== head.length ||
      !separator.every((cell) => /^:?-{3,}:?$/u.test(cell))
    )
      continue;
    const rows: string[][] = [];
    for (const candidate of lines.slice(index + 2)) {
      if (!candidate.includes('|')) break;
      rows.push(splitRow(candidate));
    }
    tables.push(rows);
  }
  return tables.length === 1 ? (tables[0] ?? null) : null;
}

export function checkTable(content: Buffer, headers: string[], expected: string[][]): Check {
  const rows = table(content.toString('utf8'), headers);
  if (!rows)
    return { pass: false, details: [`Ожидалась одна Markdown-таблица (${headers.join(', ')}).`] };
  return checkRows(rows, expected);
}

export function checkRows(rows: string[][], expected: string[][]): Check {
  return JSON.stringify(rows) === JSON.stringify(expected)
    ? { pass: true, details: [`Строки таблицы совпали (${rows.length}).`] }
    : {
        pass: false,
        details: [
          `Получены строки ${JSON.stringify(rows)}. Ожидались ${JSON.stringify(expected)}.`,
        ],
      };
}
