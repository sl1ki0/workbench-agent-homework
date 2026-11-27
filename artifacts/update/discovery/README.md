# Фоновая проверка реестра

Этот прогон записан 27 ноября 2026 года. Локальный источник `demo` проверялся командой `market watch` с интервалом в одну минуту. Использовался новый каталог состояния, а автообновление было выключено. Ни один этап не требовал модели.

| Что проверено | Свидетельство |
| --- | --- |
| Установка исходной версии `progress-summary@1.0.0` | [Ответ CLI](baseline.json) |
| Фоновая проверка заметила `progress-summary@1.1.0` и `study-note-checklist@1.0.0` после смены индекса | [Вывод watcher](watcher.txt), [события с SHA-256](market-events.jsonl) |
| Повторная проверка через минуту записала только результат опроса | [Журнал](market-events.jsonl), события `market_scan` от 20:19 и 20:20 UTC |
| Пользователь может проверить настройку автообновления и найти новый скилл | [Настройки источника](auto-off.json), [результат поиска](search.json) |
| При выключенном автообновлении установлена исходная версия | [Активная версия после новости](after-new-release.json) |
| Пакет с неверным SHA-256 отклонён, проверенная версия сохранилась | [Результат загрузки](malformed-update.json), [активная версия](after-malformed-update.json) |
| Недоступный реестр вернул диагностируемую ошибку, проверенная версия сохранилась | [Результат проверки](offline-check.json), [активная версия](after-offline-check.json) |

Следующие команды запускаются из корня проекта после `npm run build`. Временная копия позволяет менять индекс, пока фоновая проверка работает.

```bash
DEMO="$(mktemp -d "${TMPDIR:-/tmp}/workbench-discovery.XXXXXX")"
mkdir -p "$DEMO/registry"
cp -R market-fixtures/skills "$DEMO/registry/skills"
cp market-fixtures/index-baseline.json "$DEMO/registry/index.json"
printf '%s\n' '{"registries":[{"id":"demo","index":"index.json"}]}' > "$DEMO/registry/config.json"
mkt() {
  node dist/src/cli/index.js market "$@" --state-dir "$DEMO/state" --market-config "$DEMO/registry/config.json"
}
mkt install progress-summary@1.0.0
mkt auto configure demo interval 1
mkt auto configure demo poll on
node dist/src/cli/index.js market watch --state-dir "$DEMO/state" --market-config "$DEMO/registry/config.json" &
WATCHER_PID=$!
```

Дождитесь первой проверки `mkt events`, затем замените индекс. В течение минуты watcher выведет обе новости. Дайте ему ещё минуту, чтобы увидеть повторную проверку в журнале.

```bash
cp market-fixtures/index-stable.json "$DEMO/registry/index.next"
mv "$DEMO/registry/index.next" "$DEMO/registry/index.json"
# После двух плановых проверок
mkt auto status demo
mkt list
mkt search note
mkt events
kill -TERM "$WATCHER_PID"
wait "$WATCHER_PID"
cp market-fixtures/index-invalid.json "$DEMO/registry/index.json"
mkt update progress-summary@1.2.0
mkt list
mv "$DEMO/registry/index.json" "$DEMO/registry/index.offline"
mkt auto run demo
mkt list
```

В приложенных копиях журналов абсолютные пути заменены на `<DEMO_TMP>` и `<REPO>`.
