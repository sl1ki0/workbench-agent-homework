# Сценарий защиты

Команды ниже рассчитаны на запуск из корня репозитория. Для интерактивной части нужен терминал. Автоматические проверки можно показать на том же компьютере без запущенной модели.

## Подготовка

```bash
npm ci
npm run build
curl -fsS http://127.0.0.1:11434/api/version
ollama list
```

Если API ещё недоступен, откройте приложение Ollama или выполните в отдельном терминале `ollama serve`. Агент сам сервис не запускает. Запросы `/api/version` и `ollama list` проверяют доступность сервиса и наличие модели.

Для интерактивного показа можно использовать установленную `qwen3:4b`. У сохранённых серий собственный профиль `workbench-qwen3.5:2b`. Его точные параметры и команды для создания собраны отдельно. [Профиль эксперимента](../artifacts/model.md).

Создайте копию проекта и отдельный каталог состояния. В следующих командах выполняйте подстановку в том же терминале.

```bash
mkdir -p .agent
DEMO="$(mktemp -d "$PWD/.agent/defense.XXXXXX")"
cp -R workspace "$DEMO/workspace"
printf '%s\n' "$DEMO"
```

## ДЗ №1

### Исправление проекта, контекст и Bash

```bash
npm run agent -- chat --mode auto --no-skills --no-mcp \
  --workspace "$DEMO/workspace" --state-dir "$DEMO/state"
```

1. Введите «Исправь расчёт итоговой стоимости заказа, чтобы тесты проходили. Тесты не меняй. Сам найди нужные файлы, внеси исправление и запусти тесты».
2. Покажите чтение файлов, запись `order.py`, Bash с `python3 -m unittest -v`, результат `Ran 2 tests` и `OK`. Запишите идентификатор запуска с исправлением.
3. В той же сессии спросите «Какое значение теперь вернёт функция для цен 100 и 50 со скидкой 10%? Что будет при скидке 101%?». Покажите новый `run_id` при прежнем `session_id` и выполните `/stats`, затем `/exit`.
4. В shell подставьте ID запуска с правкой и покажите diff. Вызов rollback из нового процесса демонстрирует, что журнал файлов переживает выход.

```bash
RUN_ID=подставьте_id_исправления
cmp workspace/test_order.py "$DEMO/workspace/test_order.py" && echo 'Тесты совпадают'
npm run agent -- diff "$RUN_ID" --workspace "$DEMO/workspace" --state-dir "$DEMO/state"
npm run agent -- rollback "$RUN_ID" --workspace "$DEMO/workspace" --state-dir "$DEMO/state"
cmp workspace/order.py "$DEMO/workspace/order.py" && echo 'Исходный файл восстановлен'
```

### Safe, отказ и возобновление

```bash
npm run agent -- start --mode safe --no-skills --no-mcp \
  --workspace "$DEMO/workspace" --state-dir "$DEMO/state" \
  'Создай demo-note.txt с текстом demo. Если пользователь отклонит запись, прочитай order.py и кратко сообщи его назначение.'
```

В состоянии ожидания проверьте `test ! -e "$DEMO/workspace/demo-note.txt"`. Выход одноразовой команды оставляет ожидающий запуск на диске. Продолжите с тем же ID в новом процессе.

```bash
RUN_ID=подставьте_id_ожидающего_запуска
npm run agent -- resume "$RUN_ID" --decision deny --no-skills --no-mcp \
  --workspace "$DEMO/workspace" --state-dir "$DEMO/state"
test ! -e "$DEMO/workspace/demo-note.txt" && echo 'Запись отклонена'
```

В терминале и журнале покажите причину отказа, альтернативное чтение и прежний `run_id`.

### Plan Mode и задачи

```bash
npm run agent -- chat --plan --mode safe --no-skills --no-mcp \
  --workspace "$DEMO/workspace" --state-dir "$DEMO/state"
```

1. Введите «Исправь скидку в order.py, тесты не меняй. Составь план из трёх зависимых шагов. Сначала изучи файлы, потом исправь расчёт и перечитай исправление, затем запусти тесты».
2. Пока план ждёт решения, покажите `/tasks` и `/diff`. В другом терминале убедитесь, что `order.py` ещё совпадает с исходником, используя путь к копии из подготовки.
3. Введите `/approve` для плана. Снова введите `/approve` при каждом разрешённом изменении или запросе Bash. Покажите, что план и действия имеют отдельные решения.
4. После выполнения покажите `/tasks` с подтверждёнными результатами шагов. В JSONL используются `task_started`, `task_completed` и `task_id`, а планирование имеет фазу `planning`.
5. Для отклонения плана начните новый запуск в режиме `--plan` и на первом подтверждении введите `/deny`. В диалоге `/exit` завершает работу.

### Конфликт при откате

Возьмите ID успешного запуска с изменением `order.py` из Plan Mode. Измените файл снаружи и покажите отказ отката на учебной копии.

```bash
RUN_ID=подставьте_id_запуска_с_изменением
printf '\n# external demo edit\n' >> "$DEMO/workspace/order.py"
cp "$DEMO/workspace/order.py" "$DEMO/order-before-rejected-rollback.py"
npm run agent -- rollback "$RUN_ID" --workspace "$DEMO/workspace" --state-dir "$DEMO/state"
cmp "$DEMO/workspace/order.py" "$DEMO/order-before-rejected-rollback.py" && echo 'Внешняя правка сохранена'
```

### Точные проверки границ и сбоя

Для этого блока покажите исходные assertions и запустите команды на глазах проверяющего. Модель заменена тестовым адаптером. Валидация, policy, Bash, запись состояния и откат работают через код приложения. Детерминированное управление точкой сбоя показывает гарантию восстановления даже при остановке сразу после побочного эффекта.

Покажите `config/policy.json` и выполните тесты. Они проверяют разрешённую и запрещённую команды, запрет cwd и поддиректории, обход через путь или ссылку, таймаут и предел вывода Bash.

```bash
cat config/policy.json
node --test dist/test/workspace.test.js
```

Проверки runtime покрывают несколько вызовов в пачке, ошибки аргументов, правильный `tool_call_id`, подтверждение и отказ, перепроверку policy после запуска, сбой после записи и до сохранения результата, явную атрибуцию правок, повторы ID и четыре лимита. В блоке Plan Mode проверяются три задачи с зависимостями и запрет побочных действий до утверждения. Блок отката включает создание, изменение, удаление файла, просмотр diff после перезапуска и атомарный отказ при конфликте.

```bash
node --test dist/test/runtime.test.js
```

При наличии времени выведите только нужную группу тестов непосредственно во время объяснения.

```bash
node --test --test-name-pattern='interrupted action|duplicate tool call|explicit retry|budget' dist/test/runtime.test.js
node --test --test-name-pattern='planning blocks effects|declining a saved plan' dist/test/runtime.test.js
node --test --test-name-pattern='diff and rollback|rollback conflict|an external change stops' dist/test/runtime.test.js
```

## ДЗ №2

### Скиллы, настоящий MCP, артефакты и уточнение

```bash
cp eval/fixtures/progress/progress.json "$DEMO/workspace/"
cp eval/fixtures/no-skill/note.txt "$DEMO/workspace/"
npm run agent -- chat --mode auto \
  --workspace "$DEMO/workspace" --state-dir "$DEMO/state"
```

1. Введите «Составь отчёт по открытым задачам учебного трекера. Сохрани его в open-tasks.md в виде Markdown-таблицы с колонками ID и Название. Упорядочь строки по ID». Покажите выбор `open-task-report`, `mcp_tracker_list_tasks`, записанный артефакт и каталог обнаруженных скиллов.
2. Спросите «Сколько задач попало в этот отчёт? Проверь сам файл». Покажите связанную сессию.
3. Введите `/session new`, затем «Сделай короткую Markdown-сводку прогресса по progress.json. Сохрани в progress-summary.md. Приведи таблицу с колонками Ученик, Завершено, Минуты. По каждому ученику посчитай только завершённые занятия и их суммарные минуты. Добавь строку Итого». Покажите выбор `progress-summary` и результат.
4. Введите `/session new`, затем «Скопируй содержимое файла note.txt без изменений в evidence.txt». Покажите, что подходящий скилл не нужен, и проверьте копию через `cmp`.
5. Введите `/stats`, `/doctor` и `/exit`. Для сводки по отчёту переключитесь на его сессию через `/session SESSION_ID` перед вызовом команд. В TUI `/skills list` и `/mcp list` открывают списки. Используйте поиск, стрелки и Esc. Shift+Tab меняет режим, Tab подставляет команду, Ctrl+U очищает ввод. Можно печатать во время запроса, отправленный текст появится в очереди.

После выхода покажите файлы и несколько событий. `RUN_ID` здесь относится к запуску отчёта, `SESSION_ID` к его сессии.

```bash
RUN_ID=подставьте_id_запуска_отчёта
SESSION_ID=подставьте_id_сессии_отчёта
cat "$DEMO/workspace/open-tasks.md" "$DEMO/workspace/progress-summary.md"
cmp "$DEMO/workspace/note.txt" "$DEMO/workspace/evidence.txt" && echo 'Копия совпадает'
rg 'skills_discovered|skill_loaded|mcp_connected|tool_started|tool_result|model_usage|run_finished' \
  "$DEMO/state/events/$RUN_ID.jsonl"
npm run agent -- doctor "$SESSION_ID" --state-dir "$DEMO/state"
```

У событий видны ID, время, run и session ID. При обсуждении usage покажите исходные категории API и объясните, что токены кэша уже входят во входные. Если модель пропустила нужную загрузку, покажите фактический журнал как случай ошибки маршрутизации. Для трёх сценариев правила оценки заранее фиксированы.

### Расширение каталога, запреты MCP и диагностические правила

Покажите один `SKILL.md`, пример конфига MCP и запустите проверки. Проверка скиллов добавляет каталог без изменения цикла и тестирует повреждённый соседний файл. MCP-тесты соединяются с настоящим локальным stdio-сервером, выявляют заблокированный вызов и таймаут альтернативного сервера. Тесты доктора покрывают повторные ошибки и повторные чтения, а также близкие нормальные случаи.

```bash
cat skills/open-task-report/SKILL.md config/mcp.json
node --test dist/test/skills.test.js dist/test/mcp.test.js dist/test/doctor.test.js dist/test/eval.test.js
npm run agent -- doctor c91ffcb8-39b9-4e9c-a478-5be184736e50 --state-dir artifacts/doctor
```

На сохранённой попытке доктор показывает повторный отказ удаления `note.txt` и повторное чтение того же содержимого. Для каждого случая сопоставьте ID события с JSONL. Схожие нормальные случаи проверяются в `test/doctor.test.ts`. Для проверки интерфейса модели без учётных данных есть `node --test dist/test/model.test.js`. [Отчёт доктора](../artifacts/doctor/findings.txt).

### 30 реальных попыток и разбор A/B

На защите покажите уже сохранённые артефакты и воспроизведите агрегирование отчёта без LLM. Для нового прогона примените переменные окружения из [профиля](../artifacts/model.md) и используйте пустой каталог.

```bash
EVAL_DIR="$(mktemp -d "$PWD/.agent/eval-defense.XXXXXX")"
npm run eval -- extended "$EVAL_DIR"
```

Покажите манифест, 30 строк попыток, A1/B1 и сравнение. Для демонстрации сохранённой серии задайте `EVAL_DIR=artifacts/ab`.

```bash
npm run eval -- report "$EVAL_DIR"
wc -l "$EVAL_DIR/trials.jsonl"
ls "$EVAL_DIR"
cat "$EVAL_DIR/report.md"
ls "$EVAL_DIR/trials/open-tasks/A1" "$EVAL_DIR/trials/open-tasks/B1"
cat "$EVAL_DIR/trials/open-tasks/A1/result.json" "$EVAL_DIR/trials/open-tasks/B1/result.json"
```

В `manifest.json` покажите одинаковые параметры модели, policy, MCP и данные для A и B. В журналах A1/B1 найдите вызовы по ID из отчёта и сопоставьте их с проверкой файлов. При разборе покажите отдельно качество результата, выбор скилла, вызовы, ошибки и доступный usage. [Итог по гипотезе](../artifacts/ab/report.md).

## Дополнительная демонстрация каталога и защитного шлюза

В отдельном каталоге состояния найдите `progress-summary`, покажите новости, установите `1.0.0` и запросите обновления. Проведите проверку `1.1.0`, откройте `decision.json` и покажите артефакты активной и новой версии на двух разных наборах данных. Затем отправьте на проверку намеренно регрессионную `2.0.0`. По завершении покажите фактический результат шлюза, текущий manifest установки и команду отката. Используйте [готовые команды рынка](market.md).

Для быстрой проверки без модели выполните тесты интерфейса, каталога, шлюза и менеджера MCP. Терминальная проверка использует настоящий PTY и управляемый поток SSE, а менеджер MCP подключается к локальному Streamable HTTP-серверу.

```bash
npm run build
node --test dist/test/tui.test.js dist/test/market.test.js dist/test/market-gate.test.js dist/test/mcp-manager.test.js
```
