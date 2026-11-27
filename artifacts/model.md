# Профиль модели для приёмки

Серии A/B и сравнение версии запускаются на одном локальном профиле `workbench-qwen3.5:2b` с контекстом 6144. Модель — Qwen 3.5 2B из Ollama. Окружение провайдера определено до запуска. Для обоих вариантов каждого эксперимента одинаковы температура 0.2, предел ответа 512 токенов, таймаут запроса 45 с, выключенный thinking, режим auto и лимиты runtime из манифеста. Каждая попытка использует новый workspace и идентификаторы.

На записанном запуске Ollama использовал MLX и квантование `mxfp8`. SHA-256 манифеста базовой модели `dfaf2605162e689c8cac330dc4a190c4c50ad30aa47814a8fe9b79fa5127e97e`, профиля `d68d07dc886660c6ddd566ac41d52d428d373c2bc1a99645755d2b11b9de63da`.

```bash
ollama pull qwen3.5:2b
ollama create workbench-qwen3.5:2b -f artifacts/Modelfile
export AGENT_PROVIDER=ollama OPENAI_BASE_URL=http://127.0.0.1:11434/v1/
export OPENAI_API_KEY=ollama OPENAI_MODEL=workbench-qwen3.5:2b
export OPENAI_REASONING_EFFORT=none OPENAI_TEMPERATURE=0.2
export OPENAI_MAX_TOKENS=512 OPENAI_TIMEOUT_MS=45000 OPENAI_SEED=
```

Сохранённые таблицы, отчёты, исходные данные и автоматические тесты доступны независимо от модельного сервера.
