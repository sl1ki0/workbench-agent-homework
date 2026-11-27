# Результаты A/B

Модель «workbench-qwen3.5:2b». Температура 0.2, лимит ответа 512 токенов, таймаут 45000 мс.

Сохранено 30 из 30 попыток.

## Сводка

Средний расход рассчитан по попыткам с полным usage. Числа в скобках показывают количество попыток с полным, частичным и неизвестным usage.

| Сценарий | Версия | Артефакт | Инструменты | Полный зачёт | Ошибки выбора | Ошибки запуска | Входные токены | Выходные токены | Скиллы | MCP | Инструменты по имени |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Все | A | 7/15 | 10/15 | 6/15 | n/a | 6 | 10478.1 (15/0/0) | 563.9 (15/0/0) | — | tracker/list_tasks × 9 | delete_file × 15, mcp_tracker_list_tasks × 9, read_file × 32, write_file × 64 |
| Все | B | 7/15 | 10/15 | 0/15 | 10 | 4 | 9350.1 (15/0/0) | 345.3 (15/0/0) | progress-summary × 2 | tracker/list_tasks × 9 | delete_file × 7, list_files × 5, load_skill × 2, mcp_tracker_list_tasks × 9, read_file × 24, write_file × 36 |
| open-tasks | A | 3/3 | 3/3 | 3/3 | n/a | 0 | 5376.0 (3/0/0) | 345.3 (3/0/0) | — | tracker/list_tasks × 3 | mcp_tracker_list_tasks × 3, write_file × 9 |
| open-tasks | B | 3/3 | 3/3 | 0/3 | 3 | 0 | 5222.0 (3/0/0) | 238.0 (3/0/0) | — | tracker/list_tasks × 3 | mcp_tracker_list_tasks × 3, write_file × 6 |
| progress | A | 2/3 | 3/3 | 2/3 | n/a | 1 | 14818.7 (3/0/0) | 1104.0 (3/0/0) | — | — | read_file × 6, write_file × 25 |
| progress | B | 1/3 | 3/3 | 0/3 | 3 | 3 | 10092.0 (3/0/0) | 610.3 (3/0/0) | — | — | read_file × 5, write_file × 12 |
| no-skill | A | 0/3 | 0/3 | 0/3 | n/a | 2 | 10967.7 (3/0/0) | 322.7 (3/0/0) | — | — | delete_file × 13, read_file × 8, write_file × 7 |
| no-skill | B | 0/3 | 0/3 | 0/3 | 0 | 0 | 7302.3 (3/0/0) | 182.0 (3/0/0) | — | — | delete_file × 6, read_file × 4, write_file × 4 |
| mcp-failure | A | 2/3 | 1/3 | 1/3 | n/a | 0 | 7484.0 (3/0/0) | 271.7 (3/0/0) | — | tracker/list_tasks × 6 | delete_file × 2, mcp_tracker_list_tasks × 6, read_file × 5, write_file × 6 |
| mcp-failure | B | 3/3 | 2/3 | 0/3 | 3 | 0 | 8819.7 (3/0/0) | 239.0 (3/0/0) | — | tracker/list_tasks × 6 | delete_file × 1, mcp_tracker_list_tasks × 6, read_file × 4, write_file × 7 |
| progress-variant | A | 0/3 | 3/3 | 0/3 | n/a | 3 | 13744.3 (3/0/0) | 775.7 (3/0/0) | — | — | read_file × 13, write_file × 17 |
| progress-variant | B | 0/3 | 2/3 | 0/3 | 1 | 1 | 15314.3 (3/0/0) | 457.0 (3/0/0) | progress-summary × 2 | — | list_files × 5, load_skill × 2, read_file × 11, write_file × 7 |

## Попытки

| Сценарий | Версия | № | Run ID | Артефакт | Выбор | Инструменты | Входные | Выходные | Статус | Ошибка |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| open-tasks | A | 1 | [152c05ed-4f46-4227-804b-fb2ca8fd008f](trials/open-tasks/A1/events.jsonl) | да | n/a | да | 5376 | 346 | completed | — |
| open-tasks | B | 1 | [bba58e4a-567e-4e26-9bf2-0212da9b838e](trials/open-tasks/B1/events.jsonl) | да | нет | да | 5222 | 267 | completed | — |
| open-tasks | A | 2 | [03dc1236-d2f5-453f-b2f9-c25c0445cfd4](trials/open-tasks/A2/events.jsonl) | да | n/a | да | 5376 | 341 | completed | — |
| open-tasks | B | 2 | [ab639205-5c8c-444f-8652-384a0a79fcb8](trials/open-tasks/B2/events.jsonl) | да | нет | да | 5222 | 227 | completed | — |
| open-tasks | A | 3 | [e090bb09-3d2d-4340-a2fe-77ac0ed72c13](trials/open-tasks/A3/events.jsonl) | да | n/a | да | 5376 | 349 | completed | — |
| open-tasks | B | 3 | [4751a0e7-88fe-4b87-b6d0-5853657726ab](trials/open-tasks/B3/events.jsonl) | да | нет | да | 5222 | 220 | completed | — |
| progress | A | 1 | [adaba826-f2e5-484a-9736-42de671defec](trials/progress/A1/events.jsonl) | да | n/a | да | 16360 | 1209 | completed | — |
| progress | B | 1 | [bde40aa5-9de3-4644-ac60-91a801b61323](trials/progress/B1/events.jsonl) | нет | нет | да | 7365 | 466 | failed | Модель вернула пустой ответ |
| progress | A | 2 | [cc42f1de-397e-474a-a4d3-ec935bb57086](trials/progress/A2/events.jsonl) | нет | n/a | да | 16305 | 1253 | budget_exhausted | Model request limit |
| progress | B | 2 | [ef3f507a-de99-4bb0-9601-e86bc752bab8](trials/progress/B2/events.jsonl) | да | нет | да | 10625 | 631 | failed | Модель вернула пустой ответ |
| progress | A | 3 | [395e9cfb-a65a-4166-b9b4-2147034ec46e](trials/progress/A3/events.jsonl) | да | n/a | да | 11791 | 850 | completed | — |
| progress | B | 3 | [a5b3ebe8-92b0-4a4b-9e5b-60fcc5341679](trials/progress/B3/events.jsonl) | нет | нет | да | 12286 | 734 | failed | Модель вернула пустой ответ |
| no-skill | A | 1 | [5192a867-f725-45d1-b31d-0dd2d1747507](trials/no-skill/A1/events.jsonl) | нет | n/a | нет | 13866 | 408 | budget_exhausted | Model request limit |
| no-skill | B | 1 | [cd688731-2f96-4b28-8456-45891ad8f41d](trials/no-skill/B1/events.jsonl) | нет | да | нет | 6361 | 154 | completed | — |
| no-skill | A | 2 | [7537f2df-6d29-4b23-a8ec-5d9835b7662e](trials/no-skill/A2/events.jsonl) | нет | n/a | нет | 13926 | 407 | budget_exhausted | Model request limit |
| no-skill | B | 2 | [df8c046e-899f-429f-b5be-3ad4a83e107e](trials/no-skill/B2/events.jsonl) | нет | да | нет | 9185 | 238 | completed | — |
| no-skill | A | 3 | [9464d75f-92ba-493c-b418-feb3f5630af0](trials/no-skill/A3/events.jsonl) | нет | n/a | нет | 5111 | 153 | completed | — |
| no-skill | B | 3 | [e767cad9-c5f7-4f5a-83c3-d8186a9dc33e](trials/no-skill/B3/events.jsonl) | нет | да | нет | 6361 | 154 | completed | — |
| mcp-failure | A | 1 | [b170d813-523c-44b7-9bf4-59d9aa4cd4de](trials/mcp-failure/A1/events.jsonl) | нет | n/a | нет | 7111 | 270 | completed | — |
| mcp-failure | B | 1 | [217e14c1-467c-4fb8-8671-bfde38db541b](trials/mcp-failure/B1/events.jsonl) | да | нет | нет | 11641 | 310 | completed | — |
| mcp-failure | A | 2 | [601c6fb9-ca2d-4b8b-bd68-0a59180cc01f](trials/mcp-failure/A2/events.jsonl) | да | n/a | нет | 8275 | 296 | completed | — |
| mcp-failure | B | 2 | [e155c52b-8b55-4501-85f2-df73b1bc1d43](trials/mcp-failure/B2/events.jsonl) | да | нет | да | 7409 | 203 | completed | — |
| mcp-failure | A | 3 | [67b8891d-c0f9-42b7-892e-b7f47ca6186c](trials/mcp-failure/A3/events.jsonl) | да | n/a | да | 7066 | 249 | completed | — |
| mcp-failure | B | 3 | [90113abd-0823-4c7f-ac69-9bfdecb737d3](trials/mcp-failure/B3/events.jsonl) | да | нет | да | 7409 | 204 | completed | — |
| progress-variant | A | 1 | [bbda686c-1a66-479e-9548-cb0be4bf126a](trials/progress-variant/A1/events.jsonl) | нет | n/a | да | 16221 | 911 | budget_exhausted | Model request limit |
| progress-variant | B | 1 | [d31d449e-4d4d-4120-8ad8-ee647f50f815](trials/progress-variant/B1/events.jsonl) | нет | да | да | 16195 | 596 | completed | — |
| progress-variant | A | 2 | [a5c38bf4-7c49-4b29-8b17-acd07d5b54d5](trials/progress-variant/A2/events.jsonl) | нет | n/a | да | 16201 | 824 | budget_exhausted | Model request limit |
| progress-variant | B | 2 | [3fdeee36-c1f1-4171-85d9-231d009d1a82](trials/progress-variant/B2/events.jsonl) | нет | да | нет | 20724 | 293 | budget_exhausted | Model request limit |
| progress-variant | A | 3 | [89c7c4d3-60d2-4223-aefd-a1a6ebe286f0](trials/progress-variant/A3/events.jsonl) | нет | n/a | да | 8811 | 592 | failed | Модель вернула пустой ответ |
| progress-variant | B | 3 | [cbf24c8f-af89-4e54-9ebf-dfe624f82696](trials/progress-variant/B3/events.jsonl) | нет | нет | да | 9024 | 482 | completed | — |

## open-tasks, пара A1/B1

- A1 · [Журнал](trials/open-tasks/A1/events.jsonl) · mcp_tracker_list_tasks(open) (38c2e3e3-7bf8-47e4-bb2a-cbdf871753d8) → write_file(open-tasks.md) (3de6c2f8-15d4-46f8-a3bf-950e7abbd85b) → write_file(open-tasks.md) (a9780be5-317f-490a-b8bb-10978c875956) → write_file(open-tasks.md) (5a6c98f3-a925-4944-844a-d40a5887eaf5). Строки таблицы совпали (3).
- B1 · [Журнал](trials/open-tasks/B1/events.jsonl) · mcp_tracker_list_tasks(open) (b0818552-b207-4478-8fee-5938b4036347) → write_file(open-tasks.md) (f49c9925-bab0-4701-9caa-ce772d52061d) → write_file(open-tasks.md) (97446f76-d0d2-4826-b5ba-25d55df26403). Строки таблицы совпали (3).

В этой паре итог проверки артефакта совпал. Последовательность действий позволяет сравнить нагрузку и выбор скилла.

## progress, пара A1/B1

- A1 · [Журнал](trials/progress/A1/events.jsonl) · read_file(progress.json) (5e55924b-1fe0-4021-9e2d-5ace2b17f187) → write_file(progress-summary.md) (3b958123-d18f-44eb-80af-0b6aeffcd098) → write_file(progress-summary.md) (c69109a6-2ef7-4b08-bc30-b15772a6113b) → write_file(progress-summary.md) (6cbee40d-28b9-4018-836e-656fac5ee058) → ошибка write_file (8d84eac2-780e-4b51-9e9d-4ca4c6322a8a) → write_file(progress-summary.md) (60ac7c5c-e9e6-400f-9c90-95d506cad741) → write_file(progress-summary.md) (17bc5cb8-a9b1-4291-98fb-6f81e86a2c22) → ошибка read_file (9f208de0-1e9e-435a-90e7-048d1224098c) → write_file(progress-summary.md) (0138ebd9-e981-4da1-ab7f-82102d720e65) → write_file(progress-summary.md) (6e525002-3ccc-4662-a70c-7962fee6e176) → write_file(progress-summary.md) (20a066e7-74a1-4ec8-b7ac-791834d75237). Строки таблицы совпали (4).
- B1 · [Журнал](trials/progress/B1/events.jsonl) · read_file(progress.json) (866e1a54-950e-40f6-9497-492eea5133d4) → write_file(progress-summary.md) (6b7f5644-8ae5-48dc-aeb5-e7af3df574a3) → ошибка write_file (2cd022e7-0ffa-4648-83bd-d16d476a7862) → write_file(progress-summary.md) (eae311d4-2253-4b58-a5be-5aa7806ff679). Ожидалась таблица с последней строкой «Итого».

В этой паре корректный артефакт получен в A1. Критерий, на котором разошлись результаты, приведён в проверке артефакта.

## no-skill, пара A1/B1

- A1 · [Журнал](trials/no-skill/A1/events.jsonl) · read_file(note.txt) (25797763-8a09-44d0-a74b-505552c66126) → write_file(evidence.txt) (f8f1f032-2085-4e69-b54c-4887d66f4573) → ошибка delete_file (9fe82bc6-e107-4101-b1d5-927cb1187c02) → ошибка delete_file (73ac3525-4256-445c-90fe-16d15b7c2c82) → read_file(note.txt) (5a5972a2-4500-49ad-9665-957107fb7327) → write_file(evidence.txt) (899bb325-04a0-4f05-aaed-035996fb07ab) → ошибка delete_file (8b7797e3-3748-4200-b57a-eaba01a2036c) → ошибка delete_file (e1fe1391-84d4-44b2-a45b-215350ed3f1f) → read_file(note.txt) (464dda2d-f93a-4f79-814f-472659d05a8c) → write_file(evidence.txt) (54cee9ec-4866-4345-9ffe-bd513ba262e2) → ошибка delete_file (8ed9d1dd-6c84-49a2-b69e-b2b5a15d3e43) → ошибка delete_file (1f24f14d-2a79-4ac1-b5d4-599686d3d896). Байты отличаются (получено 119, эталон 120).
- B1 · [Журнал](trials/no-skill/B1/events.jsonl) · read_file(note.txt) (b5aaf20f-f659-4aa1-a40d-fcde0e86fd5d) → write_file(evidence.txt) (a1d6384a-e569-489d-8cf6-41257d40819c) → ошибка delete_file (bedc5341-cfed-4264-aff5-586f310e9cb4) → ошибка delete_file (28510141-4013-4f88-bc02-1e5cb3d15dda). Байты отличаются (получено 119, эталон 120).

В этой паре итог проверки артефакта совпал. Последовательность действий позволяет сравнить нагрузку и выбор скилла.

## mcp-failure, пара A1/B1

- A1 · [Журнал](trials/mcp-failure/A1/events.jsonl) · mcp_tracker_list_tasks(open) (004dafbf-0906-4481-a67a-671362c5c262) → ошибка mcp_tracker_list_tasks (727fb2e8-e9db-4865-8ac6-846af0e2c1dc) → mcp_tracker_list_tasks(open) (76baa6bc-2695-4c5d-aa0e-e6e12bb03094) → ошибка mcp_tracker_list_tasks (69ea9797-4ada-4f4a-8528-ccc635addc34) → write_file(tracker-status.md) (9ea56c6d-4d96-43c4-a503-824ea8df93ef) → read_file(tracker-status.md) (f3d768cb-f614-44b3-8ff8-b5c51ce4b9fb) → write_file(tracker-status.md) (b40c03c2-0d50-418d-aeb7-997ffe0f8182) → delete_file(tracker-status.md) (8dea3a47-fbc7-4a28-813e-36e3c9cf16a7). Файл результата отсутствует.
- B1 · [Журнал](trials/mcp-failure/B1/events.jsonl) · mcp_tracker_list_tasks(open) (a839241a-4739-4d3f-9347-43b0ecb7c0e7) → ошибка mcp_tracker_list_tasks (ec4cbeb0-3de2-4c8e-a9fa-8b85d7aa1999) → mcp_tracker_list_tasks(open) (c85a4136-4d13-43b9-b7fb-77feee210499) → ошибка mcp_tracker_list_tasks (8d594d7d-aa11-4766-ba81-ee26e5688fea) → write_file(tracker-status.md) (3116338a-cb3b-4d0d-8a53-dfa74cf63e38) → write_file(tracker-status.md) (ebb094e9-4aac-4949-a8e6-dc16bb6da9c3) → read_file(tracker-status.md) (95a2566b-07a5-40ca-a7ee-63f8650915df) → delete_file(tracker-status.md) (64f37580-7ade-4ba4-b30c-2813f9b02a8c) → write_file(tracker-status.md) (b39a7853-1479-438e-8c37-a94f3c96838b) → read_file(tracker-status.md) (f1dbb7ef-235d-4e2a-ac3b-70cf8f45d3a1). Артефакт сообщает об ограничении без неподтверждённых данных.

В этой паре корректный артефакт получен в B1. Критерий, на котором разошлись результаты, приведён в проверке артефакта.

## progress-variant, пара A1/B1

- A1 · [Журнал](trials/progress-variant/A1/events.jsonl) · read_file(progress.json) (1cde2e4a-0564-4e43-9076-fb17bcbc41c3) → write_file(progress-summary.md) (bdf49906-8b2a-46fd-8ead-bb08750f904a) → write_file(progress-summary.md) (be6cf431-0f48-4445-811a-f599349d49d6) → write_file(progress-summary.md) (096dc36c-c390-4ef0-9c5d-9eb85548776b) → write_file(progress-summary.md) (32ffe6e1-88bc-4afc-b74c-6b0646a1988e) → ошибка read_file (3c38d68d-e2ca-4677-aed1-f8a614cca0b4) → write_file(progress-summary.md) (68904623-5dd9-4d2f-a550-204d22e44059) → ошибка read_file (f5536b3f-6363-47cd-862b-4c1c54f43fcd) → write_file(progress-summary.md) (717fb303-aced-478e-89f4-162e20d9a772) → ошибка read_file (68e124ba-48d8-49ab-b271-47e253b46614) → write_file(progress-summary.md) (2cc9304e-a086-480e-958f-1d297d2751d0) → ошибка read_file (7a20fcc2-4220-487c-92b5-453340ae89ae). Ожидалась таблица с последней строкой «Итого». Пропуск L5 не отмечен.
- B1 · [Журнал](trials/progress-variant/B1/events.jsonl) · read_file(progress.json) (c53edc45-ca29-42e0-bf7d-a740508f16a7) → load_skill (56276ad7-1a93-4e49-bfe0-54630aa5901d) → загружен progress-summary (aa17135b-ca60-4ef1-b602-fb00fc2263ed) → read_file(progress.json) (c8949a1e-9f3d-4a04-808f-b4ce9987688b) → write_file(progress-summary.md) (1746283f-9231-4142-9501-60dfde6c7270) → write_file(progress-summary.md) (72e29168-8a46-4bf2-b033-a4a157c494c0) → write_file(progress-summary.md) (c9927f6c-7ac7-4c3a-bd24-f4d82875b21c) → write_file(progress-summary.md) (b7419f17-62aa-4218-85a9-86b0ca42f608) → read_file(progress-summary.md) (5c077f54-a03a-45b3-a307-3f2e51887e8c). Получены строки [["Анна","1","26"],["Борис","2","14"],["Вера","0","55"],["Итого","3","97"]]. Ожидались [["Анна","1","26"],["Борис","2","14"],["Вера","0","0"],["Итого","3","40"]]. Пропуск L5 не отмечен.

В этой паре итог проверки артефакта совпал. Последовательность действий позволяет сравнить нагрузку и выбор скилла.

## Вывод

Гипотеза о качестве не подтвердилась в этой серии. В сценариях со скиллами получено 7/12 корректных артефактов в A и 7/12 в B. В контрольных сценариях получено 0/3 в A и 0/3 в B.

В сценариях со скиллами средний входной расход составил 10355.8 токена в A и 9862.0 в B. Ожидание роста расхода не подтвердилось.

Результат относится к этому набору сценариев и локальной модели. Три попытки на вариант в сценарии ограничивают обобщение.
