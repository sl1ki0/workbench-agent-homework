# Каталог скиллов и проверка обновлений

Рынок читает локальные каталоги и HTTP(S)-реестры. У каждого выпуска есть имя, версия, описание, SHA-256 артефакта, дата и примечание. Конфигурация по умолчанию указывает на [демонстрационный источник](../market-fixtures/config.json). Для другого источника передайте `--market-config PATH`.

```json
{
  "registries": [
    { "id": "local", "index": "../market-fixtures/index.json" },
    { "id": "example", "index": "https://example.org/skills/index.json" }
  ]
}
```

Локальные пути разрешаются относительно конфигурации. Формат индекса показан в [index.json](../market-fixtures/index.json). Артефакт — UTF-8-файл `SKILL.md` до 64 КиБ. Загрузчик сверяет SHA-256 и метаданные, проверяет имя и версию и сохраняет артефакт в отдельной папке версии. Строки из каталога не выполняются. Доступ инструментов определяется обычной policy агента.

Агент может найти новый скилл через `search_market_skills` и запросить `install_market_skill` с точной ссылкой и SHA-256. В одном запуске доступны одна попытка установки и один выбранный скилл. В режиме `safe` установка ждёт подтверждения. Включение действует со следующего запуска, поскольку текущий уже получил снимок инструкций. Для демонстрации попросите агента подобрать и установить скилл для превращения учебной заметки в список вопросов и действий. Ожидаемая находка — `study-note-checklist`.

## Демонстрация двух состояний источника

```bash
npm run build
MARKET_STATE="$(mktemp -d "${TMPDIR:-/tmp}/workbench-market.XXXXXX")"
npm run agent -- market install progress-summary@1.0.0 --state-dir "$MARKET_STATE" --market-config market-fixtures/config-baseline.json
npm run agent -- market auto configure demo poll on --state-dir "$MARKET_STATE"
npm run agent -- market auto run demo --state-dir "$MARKET_STATE" --market-config market-fixtures/config-baseline.json
npm run agent -- market auto run demo --state-dir "$MARKET_STATE" --market-config market-fixtures/config-stable.json
npm run agent -- market auto run demo --state-dir "$MARKET_STATE" --market-config market-fixtures/config-stable.json
npm run agent -- market list --state-dir "$MARKET_STATE"
npm run agent -- market events --state-dir "$MARKET_STATE"
```

Первый манифест содержит `progress-summary@1.0.0`. Во втором появились `progress-summary@1.1.0` и `study-note-checklist@1.0.0`. Проверка объявляет новинку и обновление по одному разу. При выключенном автообновлении активной остаётся `1.0.0`. Журнал `$MARKET_STATE/market/market-events.jsonl` сохраняет время, источник, результат проверки, ошибки и обе ревизии.

[Запись фоновой проверки](../artifacts/update/discovery/README.md) содержит команды для прогона с минутным интервалом, журнал, вывод терминала и сохранённые состояния после ошибок.

## Настройки для каждого источника

```bash
npm run agent -- market auto configure demo poll on --state-dir "$MARKET_STATE"
npm run agent -- market auto configure demo update on --state-dir "$MARKET_STATE"
npm run agent -- market auto configure demo interval 60 --state-dir "$MARKET_STATE"
npm run agent -- market auto status --state-dir "$MARKET_STATE"
npm run agent -- market watch --state-dir "$MARKET_STATE" --market-config market-fixtures/config-stable.json
```

Автоматическое обнаружение запускается при старте TUI, GUI или `market watch` и повторяется с настроенным интервалом. Проверка новинок (`poll`) и применение проверенных обновлений (`update`) меняются независимо. `auto run demo` запускает один цикл. В GUI отдельные переключатели доступны в настройках источника, результаты проверок — в журнале рынка. Открытая вкладка показывает уведомления о свежих новинках.

Чтобы проверить повреждение, используйте `market-fixtures/config-invalid.json`. В нём заявлена версия `1.2.0` с неверным SHA-256. Загрузка будет отклонена, активная копия останется доступной.

## Оценка совместимости и откат

```bash
npm run agent -- market update progress-summary@1.1.0 --state-dir "$MARKET_STATE" --json
npm run agent -- market update progress-summary@2.0.0 --state-dir "$MARKET_STATE" --json
npm run agent -- market list --state-dir "$MARKET_STATE"
npm run agent -- market rollback progress-summary --state-dir "$MARKET_STATE"
```

Оценка сравнивает старую и новую версии на пяти сценариях по три независимых запуска на вариант, всего 30. Обе конфигурации используют скиллы, одну модель, один MCP и одинаковое состояние каждого сценария. Меняется версия одного скилла. Решение требует сохранности evidence, соблюдения ограничений инструментов и отсутствия регрессии по каждому сценарию. Статистика usage включена в сводку. Команда использует настроенный модельный провайдер.

Версия `1.1.0` уточняет проверку итогов. `2.0.0` меняет правило подсчёта и используется для проверки регрессии. Доказательства сохраняются под `$MARKET_STATE/market/gates/`. В каталоге лежат манифест, снимки двух версий, журналы, проверяемые артефакты, `report.md` и `decision.json`. Принятый кандидат активируется атомарно при совпадении ожидаемой старой ревизии. Отклонение сохраняет установленную копию. При продолжении прерванного запуска агент проверяет SHA-256 записанной версии и использует выбор скиллов, сохранённый в начале запуска. Откройте «Сравнения версий» в GUI или выполните `market gates` и `market gate-report ID`, чтобы перечитать сохранённое решение. Команда `rollback` восстанавливает предыдущую активную версию после проверки её SHA-256.

```bash
node --test dist/test/market.test.js dist/test/market-gate.test.js dist/test/cli-services.test.js
```

Локальные тесты доказывают изоляцию путей, SHA-256, обнаружение новинки, раздельные настройки проверки и обновления, сохранение рабочей копии при ошибке, подключение точной версии через инструмент агента, принятие и отклонение на контролируемых ответах модели и откат.
