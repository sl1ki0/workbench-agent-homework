import { checkTable, type Check } from './markdown.js';

const expected = [
  ['T1', 'Подготовить план проекта'],
  ['T3', 'Проверить расписание защиты'],
  ['T4', 'Собрать отзыв команды'],
];

export function checkOpenTasks(content: Buffer): Check {
  return checkTable(content, ['ID', 'Название'], expected);
}

export function checkClosedTasks(content: Buffer): Check {
  return checkTable(
    content,
    ['ID', 'Название'],
    [
      ['T2', 'Сдать вводное задание'],
      ['T5', 'Настроить окружение'],
    ],
  );
}
