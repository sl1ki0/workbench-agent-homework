# Проверка обновления скилла

Кандидат `progress-summary@1.1.0`, далее B. Активная версия `1.0.0`, далее A. Скиллы включены в обеих версиях.

Решение программы · **отклонить**

- open-tasks: candidate has no passing trials
- progress: candidate has no passing trials
- no-skill: candidate has no passing trials
- mcp-failure: candidate has no passing trials
- progress-variant: candidate has no passing trials
- progress B1: policy denial 12a9369c-2a81-46c6-a6fb-0fb83f287b5a
- progress B2: policy denial 32490c46-9765-4536-af81-39c09c08d47e, 8ffc270d-e6fd-42b6-8958-4cd3a7fc6294, 3b835336-a7fd-4a8e-bdb8-cc719f880b09
- no-skill B1: tool checks failed
- no-skill B1: policy denial f90725ba-7445-47bb-9347-7b7005285e94, 27443007-6879-4628-9a07-467e27b6ed9b
- no-skill B2: tool checks failed
- no-skill B2: policy denial 9576f71d-2f3e-4c0e-8804-b1072893fc31, fa531a02-272e-4731-b62a-293a6b22a3a9
- no-skill B3: tool checks failed
- no-skill B3: policy denial 25290334-3416-4ef8-8f63-2ebc35195ba3
- mcp-failure B1: tool checks failed
- progress-variant B2: policy denial add9654f-59fe-4fb0-9349-a4961f8ed1f5, af42474b-76e7-44b2-9216-48b24b2baeb2, 9ec72935-91ea-44ea-828e-d30413213209, 1dbf6d8e-ed4e-48db-851e-c8301552c18e
- progress-variant B3: policy denial 31ab7e08-7634-4794-8837-eda9f96312eb, 865524fc-a1cd-4b07-9fba-c23d2df53e5d

Предварительное правило:

- Ровно пять сценариев и по три независимых попытки каждой версии с журналами.
- Кандидат сохраняет или повышает число полных зачётов в каждом сценарии и получает минимум один зачёт в каждом.
- Каждая попытка кандидата проходит проверку инструментов и не содержит отказов policy.
- Расход токенов сравнивается по полным метрикам и не ограничивает допуск. Приоритет учебной проверки — корректность и соблюдение ограничений.

[Старая версия](versions/A/progress-summary/SKILL.md) · [Новая версия](versions/B/progress-summary/SKILL.md)

| Сценарий | Версия | Полные зачёты | Артефакт | Маршрут | Инструменты | Среднее входных | Среднее выходных | Полный usage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| open-tasks | A | 0/3 | 3 | 0 | 3 | 5222.0 | 223.3 | 3/3 |
| open-tasks | B | 0/3 | 3 | 0 | 3 | 5690.0 | 246.3 | 3/3 |
| progress | A | 0/3 | 0 | 0 | 3 | 11285.3 | 620.3 | 3/3 |
| progress | B | 0/3 | 0 | 0 | 3 | 8537.3 | 496.0 | 3/3 |
| no-skill | A | 0/3 | 0 | 3 | 2 | 6873.3 | 195.3 | 3/3 |
| no-skill | B | 0/3 | 0 | 3 | 0 | 6836.0 | 183.7 | 3/3 |
| mcp-failure | A | 0/3 | 3 | 0 | 3 | 7861.3 | 226.3 | 3/3 |
| mcp-failure | B | 0/3 | 3 | 0 | 2 | 10264.3 | 292.3 | 3/3 |
| progress-variant | A | 0/3 | 0 | 0 | 3 | 16313.7 | 701.0 | 3/3 |
| progress-variant | B | 0/3 | 0 | 0 | 3 | 12939.0 | 608.7 | 3/3 |
| Всего | A | 0/15 | 6 | 3 | 14 | 9511.1 | 393.3 | 15/15 |
| Всего | B | 0/15 | 6 | 3 | 11 | 8853.3 | 365.4 | 15/15 |

## Попытки

| Сценарий | Вариант | Журнал | Артефакт | Итог | Токены вход/выход | Ошибка |
| --- | --- | --- | --- | --- | --- | --- |
| open-tasks | A1 | [cc955d21-a1b3-457c-97f0-347bc23e1e92](trials/open-tasks/A1/events.jsonl) | [файл](trials/open-tasks/A1/open-tasks.md) | нет | 5222/224 | — |
| open-tasks | B1 | [084d00de-9d08-44d6-87f0-dc2677309f1e](trials/open-tasks/B1/events.jsonl) | [файл](trials/open-tasks/B1/open-tasks.md) | нет | 5222/208 | — |
| open-tasks | A2 | [e847da4f-40d4-4755-98f1-5031a44126ae](trials/open-tasks/A2/events.jsonl) | [файл](trials/open-tasks/A2/open-tasks.md) | нет | 5222/224 | — |
| open-tasks | B2 | [79cdb508-4102-4c87-8eee-92914f24f234](trials/open-tasks/B2/events.jsonl) | [файл](trials/open-tasks/B2/open-tasks.md) | нет | 6626/307 | — |
| open-tasks | A3 | [9e4d3986-2ad7-4099-9478-5ba1148eb467](trials/open-tasks/A3/events.jsonl) | [файл](trials/open-tasks/A3/open-tasks.md) | нет | 5222/222 | — |
| open-tasks | B3 | [f781010e-cbf1-43b4-ba10-cab53e90b1cb](trials/open-tasks/B3/events.jsonl) | [файл](trials/open-tasks/B3/open-tasks.md) | нет | 5222/224 | — |
| progress | A1 | [7e9ff88a-8a10-4f64-9acb-a89e3d662ea7](trials/progress/A1/events.jsonl) | [файл](trials/progress/A1/progress-summary.md) | нет | 7365/475 | Модель вернула пустой ответ |
| progress | B1 | [d62d305e-6016-4ba9-a822-7cc59ee62658](trials/progress/B1/events.jsonl) | [файл](trials/progress/B1/progress-summary.md) | нет | 7365/475 | Модель вернула пустой ответ |
| progress | A2 | [23ae612b-6ec8-4ca0-ac75-7a1eb9e4c345](trials/progress/A2/events.jsonl) | [файл](trials/progress/A2/progress-summary.md) | нет | 8983/609 | Модель вернула пустой ответ |
| progress | B2 | [14c3b899-9612-4a11-b807-9937fedd3625](trials/progress/B2/events.jsonl) | [файл](trials/progress/B2/progress-summary.md) | нет | 14006/764 | Модель вернула пустой ответ |
| progress | A3 | [e8ba2a86-99be-41eb-bd72-3ce43671a537](trials/progress/A3/events.jsonl) | [файл](trials/progress/A3/progress-summary.md) | нет | 17508/777 | Модель вернула пустой ответ |
| progress | B3 | [7b61c6c0-ff68-4fea-b4c1-aed0beeabeb5](trials/progress/B3/events.jsonl) | [файл](trials/progress/B3/progress-summary.md) | нет | 4241/249 | Модель вернула пустой ответ |
| no-skill | A1 | [5234c8a7-2b78-4b6c-9e2e-8e914662ddfc](trials/no-skill/A1/events.jsonl) | [файл](trials/no-skill/A1/evidence.txt) | нет | 7786/245 | — |
| no-skill | B1 | [f3d92ddc-e6bb-43fe-9ac1-7beb39a83af5](trials/no-skill/B1/events.jsonl) | [файл](trials/no-skill/B1/evidence.txt) | нет | 6361/152 | — |
| no-skill | A2 | [f236eb9e-f3d0-43b9-b1ca-4e9b3fd52d0d](trials/no-skill/A2/events.jsonl) | [файл](trials/no-skill/A2/evidence.txt) | нет | 7786/213 | — |
| no-skill | B2 | [75688f1c-0e30-44b0-9ecb-a59d95b6cb80](trials/no-skill/B2/events.jsonl) | [файл](trials/no-skill/B2/evidence.txt) | нет | 6361/186 | — |
| no-skill | A3 | [7e57b4aa-13de-4718-8eaf-962cb78a20c7](trials/no-skill/A3/events.jsonl) | [файл](trials/no-skill/A3/evidence.txt) | нет | 5048/128 | — |
| no-skill | B3 | [cb164c76-c422-4ea4-84aa-7e72b7475760](trials/no-skill/B3/events.jsonl) | [файл](trials/no-skill/B3/evidence.txt) | нет | 7786/213 | — |
| mcp-failure | A1 | [bb3c603b-be63-4cb1-9d55-6bdcbbfc8f6b](trials/mcp-failure/A1/events.jsonl) | [файл](trials/mcp-failure/A1/tracker-status.md) | нет | 7409/218 | — |
| mcp-failure | B1 | [dd948dd9-826c-4ab0-b892-2299446a9b0c](trials/mcp-failure/B1/events.jsonl) | [файл](trials/mcp-failure/B1/tracker-status.md) | нет | 14618/414 | — |
| mcp-failure | A2 | [d9db6907-21ce-4f46-9b6e-36ce00ec9e7c](trials/mcp-failure/A2/events.jsonl) | [файл](trials/mcp-failure/A2/tracker-status.md) | нет | 8766/257 | — |
| mcp-failure | B2 | [a47f31a8-37aa-40b0-9543-7a0b634d3b01](trials/mcp-failure/B2/events.jsonl) | [файл](trials/mcp-failure/B2/tracker-status.md) | нет | 7409/206 | — |
| mcp-failure | A3 | [d71d135e-3809-4582-b452-5677ad5f6397](trials/mcp-failure/A3/events.jsonl) | [файл](trials/mcp-failure/A3/tracker-status.md) | нет | 7409/204 | — |
| mcp-failure | B3 | [7a0e963e-7985-490f-8491-2cdff4030291](trials/mcp-failure/B3/events.jsonl) | [файл](trials/mcp-failure/B3/tracker-status.md) | нет | 8766/257 | — |
| progress-variant | A1 | [165e6b3e-4ba3-44f6-b5cb-b7348204fe8a](trials/progress-variant/A1/events.jsonl) | [файл](trials/progress-variant/A1/progress-summary.md) | нет | 20735/822 | Model request limit |
| progress-variant | B1 | [731bf03e-ae96-45cb-810d-e067a382cc37](trials/progress-variant/B1/events.jsonl) | [файл](trials/progress-variant/B1/progress-summary.md) | нет | 9095/469 | — |
| progress-variant | A2 | [a691cea4-95d4-4e82-9676-1e82366e181b](trials/progress-variant/A2/events.jsonl) | [файл](trials/progress-variant/A2/progress-summary.md) | нет | 19181/797 | Model request limit |
| progress-variant | B2 | [b28bedbc-a789-4c13-b151-1d5324acfad0](trials/progress-variant/B2/events.jsonl) | [файл](trials/progress-variant/B2/progress-summary.md) | нет | 19161/787 | Model request limit |
| progress-variant | A3 | [fcfbe140-2fad-4b61-9fb6-5bb43537cc70](trials/progress-variant/A3/events.jsonl) | [файл](trials/progress-variant/A3/progress-summary.md) | нет | 9025/484 | — |
| progress-variant | B3 | [4f066092-aff4-48eb-b279-46caa11e2e9d](trials/progress-variant/B3/events.jsonl) | [файл](trials/progress-variant/B3/progress-summary.md) | нет | 10561/570 | Модель вернула пустой ответ |

Файлы: [манифест](manifest.json), [таблица JSONL](trials.jsonl), [решение](decision.json).
