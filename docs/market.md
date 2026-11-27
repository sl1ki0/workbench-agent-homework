# Каталог скиллов и проверка обновлений

Рынок читает локальные каталоги и HTTP(S)-реестры. У каждого выпуска есть имя, версия, описание, SHA-256 артефакта, дата и примечание. Конфигурация по умолчанию указывает на [локальный демонстрационный каталог](../market-fixtures/config.json). Для своего реестра передайте `--market-config PATH`.

```json
{
  "registries": [
    { "id": "local", "index": "../market-fixtures/index.json" },
    { "id": "example", "index": "https://example.org/skills/index.json" }
  ]
}
```

Локальные пути разрешаются относительно конфигурации. Формат индекса описан примером [index.json](../market-fixtures/index.json). Артефакт — UTF-8-файл `SKILL.md` до 64 КиБ. Его относительный путь остаётся внутри каталога индекса или его HTTP-источника. Сервер должен возвращать артефакт напрямую. Инсталлятор сверяет SHA-256 и метаданные, проверяет имя и версию, сохраняет файл и manifest в отдельной папке версии. Набор доступных инструментов по-прежнему определяется policy агента.

## Демонстрация

Выполняйте команды из корня проекта. Каталог состояния изолирует эксперимент от обычных сессий.

```bash
npm run build
MARKET_STATE="$(mktemp -d "${TMPDIR:-/tmp}/workbench-market.XXXXXX")"
npm run agent -- market search progress --state-dir "$MARKET_STATE"
npm run agent -- market news --state-dir "$MARKET_STATE"
npm run agent -- market install progress-summary@1.0.0 --state-dir "$MARKET_STATE"
npm run agent -- market list --state-dir "$MARKET_STATE"
npm run agent -- market updates --state-dir "$MARKET_STATE"
```

Первая явная установка фиксирует базовую версию. Дальше проверка использует настроенный модельный провайдер и запускает каждую версию по одному разу на каждом из двух наборов исходных данных. У активной и новой версии одинаковые окружение, policy, лимиты, критерии и модель. Для положительного результата кандидат проходит все обязательные проверки артефакта, инструментов и маршрутизации. Отсутствие исходной версии или покрытия блокирует обновление. Версия активируется атомарно при условии, что базовая версия с тем же SHA-256 всё ещё активна.

```bash
npm run agent -- market update progress-summary@1.1.0 --state-dir "$MARKET_STATE" --json
npm run agent -- market update progress-summary@2.0.0 --state-dir "$MARKET_STATE" --json
npm run agent -- market list --state-dir "$MARKET_STATE"
npm run agent -- market rollback progress-summary --state-dir "$MARKET_STATE"
```

Версия `1.1.0` уточняет инструкцию проверки итогов. У демонстрационной `2.0.0` намеренно изменено правило подсчёта. Если модель следует этому правилу, артефакт выходит за золотые критерии, а активная версия остаётся прежней. Доказательства сохраняются под `$MARKET_STATE/market/gates/` и содержат манифест исходников, отдельные журналы и артефакты попыток, результаты проверок и `decision.json`. Команда rollback возвращает предыдущую активную установленную версию. Текущее состояние и история записаны в `$MARKET_STATE/market/installed.json`.

## Автоматическое обновление

Частоту проверок можно сохранить командой `auto on`. Периодическая проверка идёт, пока открыт интерфейс или `market watch`. `auto run` начинает один цикл с тем же шлюзом проверки. `auto off` отключает периодические проверки.

```bash
npm run agent -- market auto on 60 --state-dir "$MARKET_STATE"
npm run agent -- market auto status --state-dir "$MARKET_STATE"
npm run agent -- market watch --state-dir "$MARKET_STATE"
npm run agent -- market auto off --state-dir "$MARKET_STATE"
```

В тестах есть локальный HTTP-реестр и тестовый провайдер, который исполняет тот же рабочий сценарий с инструментами. Проверки показывают SHA-256, безопасные пути, разрешённое обновление, закрытый регрессионный кандидат, конкурентную смену активной версии и откат.

```bash
node --test dist/test/market.test.js dist/test/market-gate.test.js
```
