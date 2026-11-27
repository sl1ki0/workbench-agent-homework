import type { Check } from './markdown.js';

export function checkMcpFailure(content: Buffer): Check {
  const text = content.toString('utf8').trim();
  const acknowledged =
    /недоступ|сбой|ошиб|не удалось|не могу|не получ|unavailable|error|unable/u.test(
      text.toLowerCase(),
    );
  const hasClaims = /\d|\||всего|найден[оы]|список пуст|задач нет/u.test(text.toLowerCase());
  return acknowledged && !hasClaims && text.length <= 1000
    ? { pass: true, details: ['Артефакт сообщает об ограничении без неподтверждённых данных.'] }
    : {
        pass: false,
        details: ['Ожидалось короткое сообщение о сбое источника без численности и списка задач.'],
      };
}
