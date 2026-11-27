/* global document, fetch, TextDecoder, window, setTimeout, clearTimeout */
const byId = (id) => document.getElementById(id);
const transcript = byId('transcript');
const panel = byId('panel');
const panelContent = byId('panel-content');
const prompt = byId('prompt');
const state = {
  token: '',
  inventory: {},
  settings: {},
  operations: {},
  mode: 'safe',
  session: null,
  sessions: [],
  runs: [],
  stats: null,
  run: null,
  events: [],
  busy: false,
  activity: '',
  live: null,
  flowVersion: 0,
  panelVersion: 0,
};
const statuses = {
  running: 'Выполняется',
  awaiting_plan: 'План ждёт решения',
  awaiting_confirmation: 'Нужно подтверждение',
  uncertain: 'Нужно восстановление',
  completed: 'Завершён',
  failed: 'Ошибка',
  budget_exhausted: 'Лимит исчерпан',
};
const panelNames = {
  settings: 'Модель и thinking',
  inventory: 'Skills и MCP',
  files: 'Файлы workspace',
  logs: 'Журнал событий',
  plan: 'План и задачи',
  diff: 'Изменения workspace',
  stats: 'Статистика сессии',
  doctor: 'Доктор',
  evaluation: 'Оценки A/B',
  market: 'Marketplace',
  mcp: 'Серверы MCP',
};
const fields = ['input', 'output', 'cached', 'reasoning'];
const labels = ['Вход', 'Выход', 'Кэш', 'Рассуждения'];

function el(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function button(text, action, className = 'secondary') {
  const element = el('button', className, text);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

function legacyText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function detail(label, value) {
  const node = el('details');
  node.append(el('summary', '', label), el('pre', '', legacyText(value)));
  return node;
}

function card(heading, text) {
  const node = el('article', 'card');
  node.append(el('h3', '', heading));
  if (text) node.append(el('p', '', text));
  return node;
}

let noticeTimer;
function notice(value, isError = false) {
  const box = byId('toast');
  box.textContent = value instanceof Error ? value.message : String(value);
  box.className = isError ? 'toast error' : 'toast';
  box.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    box.hidden = true;
  }, 6300);
}

function post(data) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-workbench-token': state.token },
    body: JSON.stringify(data),
  };
}

async function api(path, data) {
  const response = await fetch(path, data === undefined ? undefined : post(data));
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function selected() {
  return state.runs.find(({ id }) => id === state.run);
}

function scrollTranscript() {
  transcript.scrollTop = transcript.scrollHeight;
}

function message(author, text, classes = '') {
  const node = el('article', `message ${classes}`);
  const body = el('div');
  body.append(el('div', 'message-title', author), el('div', 'message-text', text));
  node.append(el('div', 'avatar', author === 'Вы' ? 'Я' : 'W'), body);
  transcript.append(node);
  return node;
}

function renderEmpty() {
  const node = el('div', 'empty');
  node.append(
    el('h1', '', 'Чем заняться в workspace?'),
    el(
      'p',
      '',
      'Задайте задачу по проекту. Ход модели, инструменты и результаты появятся в инспекторе запуска.',
    ),
  );
  const suggestions = el('div', 'suggestions');
  for (const [title, example] of [
    ['Изучить проект', 'Покажи структуру проекта и кратко опиши назначение файлов.'],
    ['Составить план', 'Изучи проект и предложи план проверки расчёта заказа.'],
    ['Сводка MCP', 'Найди открытые учебные задачи и составь краткую сводку.'],
  ])
    suggestions.append(
      button(
        title,
        () => {
          prompt.value = example;
          if (title === 'Составить план') {
            state.mode = 'plan';
            byId('mode').value = 'plan';
          }
          prompt.focus();
        },
        'suggestion',
      ),
    );
  node.append(suggestions);
  transcript.append(node);
}

function metric(value) {
  if (value?.total == null) return '—';
  return value.status === 'partial'
    ? `${value.total.toLocaleString('ru-RU')}*`
    : value.total.toLocaleString('ru-RU');
}

function liveUsage(field, recorded, requests, samples) {
  const values = samples
    .map((sample) => sample?.[field])
    .filter((value) => typeof value === 'number');
  const known = (recorded?.known ?? 0) + values.length;
  return {
    total: known ? (recorded?.total ?? 0) + values.reduce((sum, count) => sum + count, 0) : null,
    status: known < requests ? 'partial' : 'complete',
  };
}

function renderUsage() {
  const session = state.stats;
  const samples = state.busy
    ? state.events.filter(({ type }) => type === 'model_usage').map(({ data }) => data.usage)
    : [];
  const requests =
    (session?.requests ?? 0) +
    (state.busy ? state.events.filter(({ type }) => type === 'model_request').length : 0);
  const text = fields
    .slice(0, 3)
    .map(
      (key, index) =>
        `${labels[index]} ${metric(liveUsage(key, session?.usage?.[key], requests, samples))}`,
    );
  byId('usage-line').textContent = [...text, `Запросы ${requests}`].join(' · ');
  byId('usage-line').title =
    'Сумма по сессии. * означает неполный usage. Кэш входит во входной расход.';
}

function statusBadge() {
  const run = selected();
  const box = byId('run-badge');
  box.textContent = state.busy
    ? state.activity || 'Выполняется'
    : statuses[run?.status] || 'Ожидает ввода';
  box.className = `run-badge ${state.busy ? 'work' : run?.status.startsWith('awaiting') || run?.status === 'uncertain' ? 'pending' : run?.error ? 'error' : 'quiet'}`;
}

function renderNavigation() {
  const nav = byId('sessions');
  nav.replaceChildren();
  if (!state.sessions.length) nav.append(el('div', 'muted', 'Сохранённых сессий нет'));
  for (const session of state.sessions) {
    const node = button(
      '',
      () => {
        if (!state.busy) selectSession(session.id).catch((error) => notice(error, true));
        byId('sidebar').classList.remove('open');
      },
      'session',
    );
    node.setAttribute('aria-current', String(session.id === state.session));
    node.title = session.title;
    node.append(
      el('span', '', '▱'),
      el('span', 'title', session.title),
      el('span', 'number', String(session.count)),
    );
    nav.append(node);
  }
  byId('session-title').textContent =
    state.sessions.find(({ id }) => id === state.session)?.title || 'Новая сессия';
  const picker = byId('run-select');
  picker.replaceChildren();
  if (!state.runs.length) picker.append(el('option', '', 'Нет запусков'));
  for (const [index, run] of state.runs.entries()) {
    const option = el(
      'option',
      '',
      `#${index + 1} · ${run.id.slice(0, 7)} · ${statuses[run.status] || run.status}`,
    );
    option.value = run.id;
    picker.append(option);
  }
  if (state.run) picker.value = state.run;
  picker.disabled = !state.runs.length || state.busy;
}

function toolName(data) {
  if (data.server && data.tool) return `${data.server}/${data.tool}`;
  return data.name || data.tool || 'Инструмент';
}

function renderFlow() {
  const run = selected();
  const requests = state.events.filter(({ type }) => type === 'model_request').length;
  const tools = new Map();
  for (const { type, data } of state.events) {
    if (type !== 'tool_started' && type !== 'tool_result' && type !== 'tool_denied') continue;
    const call = data.call_id || toolName(data);
    const result =
      type === 'tool_started'
        ? 'active'
        : type === 'tool_denied' || data.result?.ok === false
          ? 'error'
          : 'done';
    tools.set(call, { label: toolName(data), result });
  }
  const approved = run?.tasks?.filter(({ status }) => status === 'completed').length ?? 0;
  const forcedError = Boolean(run?.error);
  const flow = byId('flow');
  flow.replaceChildren();
  const currentTools = [...tools.values()];
  const stages = [
    {
      title: 'Запрос',
      note: run?.prompt || (state.busy ? 'Отправлен' : 'Задайте задачу'),
      status: run || state.busy ? 'done' : '',
      panel: 'logs',
    },
    {
      title: 'Модель',
      note: requests ? `Запросы: ${requests}` : state.busy ? 'Соединение' : 'Ожидание',
      status:
        state.busy && !state.activity?.startsWith('Инструмент') ? 'active' : requests ? 'done' : '',
      panel: 'logs',
    },
    {
      title: 'Инструменты',
      note: currentTools.map(({ label }) => label).at(-1) || 'Вызовов нет',
      status: currentTools.some(({ result }) => result === 'active')
        ? 'active'
        : currentTools.length
          ? 'done'
          : '',
      panel: 'logs',
    },
    {
      title: 'План и проверка',
      note: run?.tasks?.length ? `${approved} из ${run.tasks.length} выполнено` : 'По задаче',
      status: approved ? 'done' : '',
      panel: 'plan',
    },
    {
      title: 'Результат',
      note: statuses[run?.status] || 'Ожидается',
      status: forcedError ? 'error' : run?.status === 'completed' ? 'done' : '',
      panel: 'diff',
    },
  ];
  for (const [index, stage] of stages.entries()) {
    const item = button('', () => openPanel(stage.panel), 'flow-step');
    item.dataset.status = stage.status;
    const meta = el('span', 'flow-meta');
    const note = el('small', '', stage.note);
    note.title = stage.note;
    meta.append(el('strong', '', stage.title), note);
    item.append(el('span', 'node', stage.status === 'done' ? '✓' : String(index + 1)), meta);
    flow.append(item);
  }
  if (currentTools.length) {
    const list = el('div', 'tool-list');
    for (const tool of currentTools.slice(-8))
      list.append(
        el(
          'div',
          `tool-state ${tool.result}`,
          `${tool.result === 'done' ? '✓' : tool.result === 'error' ? '!' : '…'} ${tool.label}`,
        ),
      );
    flow.append(list);
  }
}

function renderPending() {
  const target = byId('pending');
  target.replaceChildren();
  target.hidden = true;
  const run = state.runs.at(-1);
  const allowed = ['awaiting_plan', 'awaiting_confirmation', 'uncertain', 'running'];
  if (state.busy || !run || !allowed.includes(run.status)) return;
  target.hidden = false;
  const node = el('div', 'pending-card');
  node.append(el('strong', '', statuses[run.status]));
  if (run.pending?.tool)
    node.append(el('p', '', run.pending.tool), el('pre', '', legacyText(run.pending.args)));
  if (run.plan) node.append(button('Открыть план', () => openPanel('plan')));
  const actionList = el('div', 'pending-buttons');
  let attribution;
  if (run.pending?.changedPaths?.length) {
    attribution = el('select');
    for (const [value, text] of [
      ['', 'Укажите принадлежность изменений'],
      ['yes', 'Это изменения агента'],
      ['no', 'Это внешние изменения'],
    ]) {
      const option = el('option', '', text);
      option.value = value;
      attribution.append(option);
    }
    node.append(el('p', '', run.pending.changedPaths.join(', ')), attribution);
  }
  const decisions =
    run.status === 'running'
      ? [[undefined, 'Продолжить']]
      : run.status === 'uncertain'
        ? [
            ['retry', 'Повторить'],
            ['skip', 'Отметить ошибку'],
            ['abort', 'Остановить'],
          ]
        : [
            ['approve', 'Подтвердить'],
            ['deny', 'Отклонить'],
          ];
  for (const [value, label] of decisions) {
    actionList.append(
      button(
        label,
        () => {
          if (attribution && !attribution.value)
            return notice('Укажите принадлежность изменений', true);
          void execute('/api/resume', {
            runId: run.id,
            decision: value,
            ...(attribution ? { attributeChanges: attribution.value === 'yes' } : {}),
          });
        },
        value === 'approve' ? 'primary' : 'secondary',
      ),
    );
  }
  node.append(actionList);
  target.append(node);
}

function renderConversation() {
  transcript.replaceChildren();
  if (!state.runs.length) renderEmpty();
  for (const run of state.runs) {
    if (run.prompt) message('Вы', run.prompt, 'user');
    if (run.final) message('Workbench', run.final);
    else if (run.error) message('Workbench', run.error, 'error');
  }
  scrollTranscript();
}

async function loadEvents(id) {
  const request = ++state.flowVersion;
  const events = id ? await api(`/api/logs/${id}`) : [];
  if (request !== state.flowVersion) return;
  state.events = events;
  renderFlow();
}

async function selectSession(id, target) {
  state.session = id;
  const session = id ? await api(`/api/session/${id}`) : { runs: [], stats: null };
  if (state.session !== id) return;
  state.runs = session.runs;
  state.stats = session.stats;
  state.run = target || state.runs.at(-1)?.id || null;
  renderConversation();
  renderNavigation();
  renderUsage();
  renderPending();
  statusBadge();
  await loadEvents(state.run);
}

function liveText() {
  return state.live?.querySelector('.message-text');
}

function onFrame(frame) {
  if (frame.type === 'event') {
    const { type, data } = frame.event;
    state.events.push(frame.event);
    if (type === 'model_request') {
      state.activity = 'Запрос к модели';
      const text = liveText();
      if (text) text.textContent = '';
    }
    if (type === 'run_started') state.run = frame.event.run_id;
    if (type === 'tool_started') state.activity = `Инструмент · ${toolName(data)}`;
    if (type === 'tool_result') state.activity = `Результат · ${toolName(data)}`;
    statusBadge();
    renderFlow();
    if (type === 'model_request' || type === 'model_usage') renderUsage();
  }
  if (frame.type === 'progress') {
    if (frame.progress.type === 'thinking') {
      state.activity = 'Thinking';
      statusBadge();
    }
    if (frame.progress.type === 'text') {
      const text = liveText();
      if (text) text.append(document.createTextNode(frame.progress.text));
      state.activity = 'Ответ модели';
      statusBadge();
      scrollTranscript();
    }
  }
}

async function streamRun(path, input) {
  const response = await fetch(path, post(input));
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let output;
  for (;;) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const frame = JSON.parse(line);
      if (frame.type === 'error') throw new Error(frame.error);
      if (frame.type === 'result') output = frame.result;
      else onFrame(frame);
    }
    if (done) break;
  }
  if (!output) throw new Error('Соединение прервано. Откройте сохранённую сессию.');
  return output;
}

async function execute(path, input) {
  if (state.busy) return;
  state.busy = true;
  state.activity = 'Подключение к модели';
  state.events = [];
  state.flowVersion++;
  byId('send').disabled = true;
  byId('new-session').disabled = true;
  if (input.prompt) {
    transcript.querySelector('.empty')?.remove();
    message('Вы', input.prompt, 'user');
  }
  state.live = message('Workbench', 'Ожидаю ответ…', 'live-message');
  statusBadge();
  renderPending();
  renderFlow();
  scrollTranscript();
  let output;
  try {
    output = await streamRun(path, input);
  } catch (error) {
    notice(error, true);
    if (input.prompt && !prompt.value) prompt.value = input.prompt;
  } finally {
    state.live = null;
    state.busy = false;
    state.activity = '';
    byId('send').disabled = false;
    byId('new-session').disabled = false;
  }
  try {
    state.sessions = await api('/api/sessions');
    await selectSession(output?.sessionId || state.session, output?.id);
  } catch (error) {
    notice(error, true);
    statusBadge();
  }
}

function settingsView() {
  const form = el('form');
  const modelLabel = el('label', 'field');
  const modelInput = el('input');
  modelLabel.append(el('span', '', 'Идентификатор модели'), modelInput);
  modelInput.value = state.settings.model || '';
  modelInput.maxLength = 160;
  modelInput.placeholder = state.settings.defaultModel || 'Модель из .env';
  const effortLabel = el('label', 'field');
  const effort = el('select');
  effortLabel.append(el('span', '', 'Thinking'), effort);
  for (const [key, title] of [
    ['default', 'Из окружения'],
    ['off', 'Выключено'],
    ['low', 'Низкий'],
    ['medium', 'Средний'],
    ['high', 'Высокий'],
  ]) {
    const option = el('option', '', title);
    option.value = key;
    effort.append(option);
  }
  effort.value = state.settings.effort || 'default';
  const save = el('button', 'primary', 'Применить');
  form.append(
    el(
      'p',
      '',
      state.settings.error ||
        `Провайдер: ${state.settings.provider || '—'}. Температура: ${state.settings.temperature ?? '—'}. Лимит ответа: ${state.settings.maxTokens ?? '—'}.`,
    ),
    modelLabel,
    effortLabel,
    save,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      state.settings = await api('/api/settings', {
        model: modelInput.value,
        effort: effort.value,
      });
      showModel();
      panel.close();
      notice('Настройки сохранены для следующих запросов');
    } catch (error) {
      notice(error, true);
    }
  });
  return form;
}

function inventoryView() {
  const list = el('div', 'cards');
  const settings = state.inventory;
  const global = card('Skills', settings.skillsEnabled ? 'Каталог активен' : 'Каталог выключен');
  list.append(global);
  if (typeof settings.selectionEnabled === 'boolean')
    global.append(
      button(settings.selectionEnabled ? 'Выключить каталог' : 'Включить каталог', () =>
        changeSkills({ enabled: !settings.selectionEnabled }),
      ),
    );
  for (const item of settings.catalog ||
    (settings.skills || []).map((name) => ({ name, enabled: true }))) {
    const node = card(item.name, item.description || (item.enabled ? 'Включён' : 'Выключен'));
    if (typeof settings.selectionEnabled === 'boolean') {
      node.append(
        button(item.enabled ? 'Выключить' : 'Включить', () =>
          changeSkills({ skill: item.name, enabled: !item.enabled }),
        ),
      );
    }
    if (item.estimatedTokens) node.append(el('span', 'muted', `≈ ${item.estimatedTokens} токенов`));
    list.append(node);
  }
  if (settings.skillErrors) list.append(card('Ошибки каталога', String(settings.skillErrors)));
  list.append(card('MCP', settings.mcpEnabled ? 'Настроенные серверы' : 'Выключен'));
  for (const server of settings.servers || [])
    list.append(card(server.name, server.error || server.tools.join(', ') || 'Подключён'));
  return list;
}

async function changeSkills(input) {
  try {
    state.inventory = await api('/api/skills', input);
    await openPanel('inventory');
  } catch (error) {
    notice(error, true);
  }
}

async function fileView() {
  const { files, truncated } = await api('/api/files');
  const list = el('div', 'cards');
  if (!files.length) list.append(el('p', '', 'Нет доступных файлов.'));
  for (const path of files) {
    list.append(
      button(path, async () => {
        try {
          const data = await api(`/api/file?path=${encodeURIComponent(path)}`);
          byId('panel-title').textContent = path;
          panelContent.replaceChildren(
            button('Назад к файлам', () => openPanel('files')),
            el('pre', '', data.content),
            ...(data.truncated ? [el('p', '', 'Показан фрагмент файла.')] : []),
          );
        } catch (error) {
          notice(error, true);
        }
      }),
    );
  }
  if (truncated) list.append(el('p', '', 'Показаны первые 300 файлов.'));
  return list;
}

function logsView() {
  const root = el('div');
  root.append(el('p', '', `События выбранного запуска: ${state.events.length}`));
  for (const event of state.events) {
    const timestamp = event.time.split('T').at(1)?.slice(0, 8) || '';
    const target = event.type.startsWith('tool_') ? ` · ${toolName(event.data)}` : '';
    root.append(detail(`${timestamp} · ${event.type}${target}`, event));
  }
  return root;
}

function planView(run) {
  const root = el('div', 'cards');
  if (!run?.plan) return el('p', '', 'У этого запуска нет утверждаемого плана.');
  root.append(card(run.plan.goal, run.plan.doneCriteria));
  if (run.plan.risks.length) root.append(card('Риски', run.plan.risks.join(' · ')));
  if (run.plan.assumptions.length) root.append(card('Допущения', run.plan.assumptions.join(' · ')));
  for (const task of run.tasks) {
    const item = card(
      `${task.id} · ${task.description}`,
      `${statuses[task.status] || task.status} · ${task.verification}`,
    );
    item.append(
      el(
        'p',
        '',
        task.dependsOn.length ? `Зависимости: ${task.dependsOn.join(', ')}` : 'Без зависимостей',
      ),
    );
    if (task.tools.length) item.append(el('p', '', `Инструменты: ${task.tools.join(', ')}`));
    if (task.evidenceCallId) item.append(el('p', '', `Доказательство: ${task.evidenceCallId}`));
    root.append(item);
  }
  return root;
}

async function diffView(run) {
  if (!run) return el('p', '', 'Выберите запуск.');
  const changes = await api(`/api/diff/${run.id}`);
  if (!changes.length) return el('p', '', 'Нет изменений файлов.');
  const view = el('div');
  for (const change of changes) {
    view.append(detail(change.path, change.text));
    if (change.truncated) view.append(el('p', '', 'Показан фрагмент diff.'));
  }
  if (run.rolledBack) view.append(el('p', '', 'Изменения откачены.'));
  else if (['completed', 'failed', 'budget_exhausted'].includes(run.status)) {
    view.append(
      button(
        'Откатить этот запуск',
        async () => {
          if (!window.confirm('Откатить изменения выбранного запуска?')) return;
          try {
            await api('/api/rollback', { runId: run.id });
            await selectSession(state.session, run.id);
            await openPanel('diff');
            notice('Откат выполнен');
          } catch (error) {
            notice(error, true);
          }
        },
        'danger',
      ),
    );
  }
  return view;
}

function statsView() {
  const info = state.stats;
  if (!info) return el('p', '', 'Выберите сессию.');
  const root = el('div', 'cards');
  root.append(
    card(
      'Сессия',
      `Запуски: ${info.runs}. Запросы: ${info.requests}. Уникальные инструменты: ${info.uniqueTools}. Уникальные скиллы: ${info.uniqueSkills}.`,
    ),
  );
  fields.forEach((field, i) =>
    root.append(card(labels[i], `${metric(info.usage[field])} · ${info.usage[field].status}`)),
  );
  for (const [label, frequency] of [
    ['Инструменты', info.tools],
    ['Загрузки Skills', info.skills],
    ['MCP', info.mcp],
  ]) {
    root.append(
      card(
        label,
        Object.entries(frequency)
          .map(([name, count]) => `${name} ×${count}`)
          .join(' · ') || 'Нет вызовов',
      ),
    );
  }
  const run = selected();
  if (run)
    root.append(
      card(
        'Лимиты выбранного запуска',
        `Модель ${run.spent.modelCalls}/${run.limits.modelCalls} · Инструменты ${run.spent.toolCalls}/${run.limits.toolCalls} · Изменения ${run.spent.sideEffects}/${run.limits.sideEffects} · Байты ${run.spent.resultBytes}/${run.limits.resultBytes}`,
      ),
    );
  return root;
}

async function doctorView() {
  if (!state.session) return el('p', '', 'Выберите сессию.');
  const data = await api(`/api/doctor/${state.session}`);
  const root = el('div', 'cards');
  for (const limitation of data.limitations) root.append(el('p', '', limitation));
  for (const run of data.runs) {
    const node = card(
      run.run_id,
      `События: ${run.events}. Запросы: ${run.requests}. Диагностики: ${run.findings.length}.`,
    );
    for (const limitation of run.limitations) node.append(el('p', '', limitation));
    for (const item of run.findings)
      node.append(detail(item.title || item.rule || item.type || 'Диагностика', item));
    root.append(node);
  }
  root.append(detail('Полный отчёт', data));
  return root;
}

function formField(label, control) {
  const field = el('label', 'field');
  field.append(el('span', '', label), control);
  return field;
}

function textInput(placeholder) {
  const input = el('input');
  input.placeholder = placeholder;
  return input;
}

function selectInput(choices) {
  const input = el('select');
  for (const [value, text] of choices) {
    const option = el('option', '', text);
    option.value = value;
    input.append(option);
  }
  return input;
}

async function mcpView() {
  const actions = state.operations.mcp || [];
  const view = el('div', 'cards');
  if (!actions.length || !state.inventory.mcpEnabled)
    return el('p', '', 'Управление MCP отключено в текущем запуске.');
  const serverList = el('div', 'cards');
  function showServers(result) {
    serverList.replaceChildren();
    for (const server of result.servers ?? []) {
      const node = card(
        `${server.server} · ${server.status === 'connected' ? 'Подключён' : 'Ошибка'}`,
        [server.transport, server.error || server.tools?.join(', ')].filter(Boolean).join(' · '),
      );
      if (server.denied?.length)
        node.append(el('p', '', `Заблокировано: ${server.denied.join(', ')}`));
      if (actions.includes('remove'))
        node.append(
          button(
            'Удалить',
            () =>
              invokeOperation('mcp', 'remove', { id: server.server }, `Удалить ${server.server}`),
            'danger',
          ),
        );
      serverList.append(node);
    }
    if (!result.servers?.length) serverList.append(el('p', '', 'Серверов нет.'));
  }
  const heading = card('Подключения');
  if (actions.includes('test'))
    heading.append(
      button('Проверить подключения', async () => {
        try {
          showServers(await api('/api/mcp/test', {}));
        } catch (error) {
          notice(error, true);
        }
      }),
    );
  view.append(heading, serverList);
  if (actions.includes('list')) showServers(await api('/api/mcp/list', {}));

  const id = textInput('tracker');
  id.required = true;
  id.pattern = '[a-z][a-z0-9-]{0,30}';
  const transport = selectInput([
    ['stdio', 'Локальный stdio'],
    ['http', 'Streamable HTTP'],
  ]);
  const command = textInput('node');
  const args = textInput('["path/to/server.js"]');
  const commandArea = el('div');
  commandArea.append(formField('Команда', command), formField('Аргументы · JSON-массив', args));
  const address = textInput('https://example.org/mcp');
  const addressArea = formField('Адрес', address);
  addressArea.hidden = true;
  const allowed = textInput('list_tasks, get_task');
  allowed.required = true;
  function showTransport() {
    commandArea.hidden = transport.value !== 'stdio';
    addressArea.hidden = transport.value === 'stdio';
  }
  transport.addEventListener('change', showTransport);
  if (actions.includes('add')) {
    const add = el('form', 'card');
    add.append(
      el('h3', '', 'Добавить сервер'),
      formField('ID', id),
      formField('Транспорт', transport),
      commandArea,
      addressArea,
      formField('Read-only tools · через запятую', allowed),
      el('button', 'primary', 'Сохранить сервер'),
    );
    add.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const allowReadOnly = allowed.value
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean);
        if (!allowReadOnly.length) throw new Error('Укажите имена разрешённых инструментов.');
        const config =
          transport.value === 'stdio'
            ? { command: command.value.trim(), args: JSON.parse(args.value || '[]'), allowReadOnly }
            : { url: address.value.trim(), allowReadOnly };
        if (
          transport.value === 'stdio' &&
          (!config.command ||
            !Array.isArray(config.args) ||
            !config.args.every((value) => typeof value === 'string'))
        ) {
          throw new Error('Введите команду и массив строк для аргументов.');
        }
        await invokeOperation('mcp', 'add', { id: id.value, config }, `Добавить ${id.value}`);
      } catch (error) {
        notice(error, true);
      }
    });
    view.append(add);
  }

  if (actions.includes('search')) {
    const search = el('form', 'card');
    const query = textInput('Ключевые слова');
    query.required = true;
    const results = el('div', 'cards');
    search.append(
      el('h3', '', 'Поиск в официальном реестре'),
      formField('Запрос', query),
      el('button', 'secondary', 'Найти'),
      results,
    );
    search.addEventListener('submit', async (event) => {
      event.preventDefault();
      results.replaceChildren(el('p', '', 'Поиск…'));
      try {
        const { entries } = await api('/api/mcp/search', { query: query.value });
        results.replaceChildren();
        for (const entry of entries) {
          const node = card(`${entry.name} · ${entry.version}`, entry.description);
          for (const url of entry.urls) {
            node.append(el('p', '', url));
            if (actions.includes('add'))
              node.append(
                button('Заполнить адрес подключения', () => {
                  transport.value = 'http';
                  address.value = url;
                  showTransport();
                  id.focus();
                }),
              );
          }
          results.append(node);
        }
        if (!entries.length) results.append(el('p', '', 'В реестре нет совпадений.'));
      } catch (error) {
        results.replaceChildren(el('p', '', error.message));
      }
    });
    view.append(search);
  }
  return view;
}

function marketRows(entries, actions, catalog = false) {
  const list = el('div', 'cards');
  for (const entry of entries) {
    const release = entry.candidate ?? entry;
    const title = release.title || release.name || 'Скилл';
    const active = entry.active;
    const node = card(title, release.description || active?.description || '');
    const version = release.version ?? active?.version;
    if (version) node.append(el('p', '', `Версия ${version}`));
    const control = el('div', 'card-actions');
    const name = release.name || entry.name;
    const input = { name, version: release.version, registry: release.registry };
    if (catalog && actions.includes('install'))
      control.append(
        button('Установить', () =>
          invokeOperation('market', 'install', input, `Установить ${name}`),
        ),
      );
    if ((entry.candidate || active) && actions.includes('update'))
      control.append(
        button('Обновить через eval-gate', () =>
          invokeOperation(
            'market',
            'update',
            entry.candidate ? input : { name },
            `Проверить новую версию ${name}?`,
          ),
        ),
      );
    if (active && actions.includes('rollback'))
      control.append(
        button('Откатить версию', () =>
          invokeOperation('market', 'rollback', { name }, `Откатить ${name}`),
        ),
      );
    node.append(control, detail('Данные версии', entry));
    list.append(node);
  }
  if (!entries.length) list.append(el('p', '', 'Записей пока нет.'));
  return list;
}

async function marketView() {
  const actions = state.operations.market || [];
  if (!actions.length) return el('p', '', 'Marketplace не подключён.');
  const view = el('div', 'cards');
  const entries = actions.includes('list') ? await api('/api/market/list', {}) : [];
  const installed = entries.entries || entries.items || (Array.isArray(entries) ? entries : []);
  view.append(card('Установленные скиллы'), marketRows(installed, actions));
  if (actions.includes('search')) {
    const form = el('form', 'card');
    const query = textInput('Имя или описание');
    const result = el('div');
    form.append(
      el('h3', '', 'Каталог'),
      formField('Поиск', query),
      el('button', 'secondary', 'Найти'),
      result,
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      result.replaceChildren(el('p', '', 'Поиск…'));
      try {
        const found = await api('/api/market/search', { query: query.value });
        result.replaceChildren(marketRows(found.entries || found, actions, true));
      } catch (error) {
        result.replaceChildren(el('p', '', error.message));
      }
    });
    view.append(form);
  }
  const controls = el('div', 'card-actions');
  const results = el('div');
  for (const [action, title] of [
    ['news', 'Новинки'],
    ['updates', 'Доступные обновления'],
  ]) {
    if (!actions.includes(action)) continue;
    controls.append(
      button(title, async () => {
        try {
          const found = await api(`/api/market/${action}`, {});
          results.replaceChildren(marketRows(found.entries || found, actions, action === 'news'));
        } catch (error) {
          notice(error, true);
        }
      }),
    );
  }
  view.append(controls, results);
  if (actions.includes('gates')) {
    const history = el('div', 'cards');
    view.append(
      button('Сравнения версий', async () => {
        try {
          const entries = await api('/api/market/gates', {});
          history.replaceChildren();
          for (const entry of entries) {
            const labels = {
              accepted: 'Принято',
              rejected: 'Отклонено',
              pending: 'Решение ожидается',
            };
            const title = `${entry.candidate?.name || 'Скилл'} · ${entry.baseline?.version || '?'} → ${entry.candidate?.version || '?'}`;
            const node = card(
              title,
              `${labels[entry.status] || entry.status} · ${entry.trials ?? '?'} попыток · ${entry.time}`,
            );
            const report = el('div');
            node.append(
              button('Показать отчёт', async () => {
                try {
                  const details = await api('/api/market/gate-report', { id: entry.id });
                  report.replaceChildren(el('pre', '', details.report || details.reason));
                } catch (error) {
                  notice(error, true);
                }
              }),
              report,
            );
            history.append(node);
          }
          if (!entries.length) history.append(el('p', '', 'Сравнений версий пока нет.'));
        } catch (error) {
          notice(error, true);
        }
      }),
      history,
    );
  }
  if (actions.includes('events')) {
    const journal = el('div');
    view.append(
      button('Журнал рынка', async () => {
        try {
          const events = await api('/api/market/events', {});
          journal.replaceChildren();
          for (const event of events) {
            const before = event.old
              ? `${event.old.name}@${event.old.version} #${event.old.digest.slice(0, 8)}`
              : '';
            const after = event.next
              ? `${event.next.name}@${event.next.version} #${event.next.digest.slice(0, 8)}`
              : '';
            const summary = [
              event.time,
              event.registry,
              event.result,
              before && after ? `${before} → ${after}` : after || before,
              event.error,
            ]
              .filter(Boolean)
              .join(' · ');
            journal.append(card(event.type, summary));
          }
          if (!events.length) journal.append(el('p', '', 'Проверок пока нет.'));
        } catch (error) {
          notice(error, true);
        }
      }),
      journal,
    );
  }
  if (actions.includes('auto')) {
    const auto = await api('/api/market/auto', { action: 'status' });
    for (const source of auto.sources ?? []) {
      const schedule = card(`Настройки источника ${source.registry}`);
      const poll = document.createElement('input');
      poll.type = 'checkbox';
      poll.checked = Boolean(source.pollingEnabled);
      const update = document.createElement('input');
      update.type = 'checkbox';
      update.checked = Boolean(source.autoEnabled);
      const interval = textInput('60');
      interval.type = 'number';
      interval.value = String(source.intervalMinutes);
      interval.min = '1';
      interval.max = '10080';
      schedule.append(
        formField('Проверять новинки автоматически', poll),
        formField('Автоматически обновлять после eval', update),
        formField('Интервал, минуты', interval),
        button('Сохранить настройки', () =>
          invokeOperation(
            'market',
            'auto',
            {
              action: 'configure',
              registry: source.registry,
              pollingEnabled: poll.checked,
              autoEnabled: update.checked,
              intervalMinutes: Number(interval.value),
            },
            `Настройки ${source.registry}`,
          ),
        ),
        button('Проверить сейчас', () =>
          invokeOperation(
            'market',
            'auto',
            {
              action: 'run',
              registry: source.registry,
            },
            `Проверить ${source.registry}`,
          ),
        ),
      );
      if (source.last) schedule.append(detail('Последняя проверка', source.last));
      view.append(schedule);
    }
  }
  return view;
}

async function evaluationView() {
  const actions = state.operations.evaluation || [];
  if (!actions.length) return el('p', '', 'Оценка A/B не подключена.');
  const view = el('div', 'cards');
  if (actions.includes('run')) {
    const header = card(
      'Запуск эксперимента',
      'Серия запускается явно. Результаты сохраняются по каждому испытанию.',
    );
    const suite = selectInput([
      ['base', 'Базовый набор'],
      ['extended', 'Расширенный набор'],
    ]);
    header.append(
      formField('Набор сценариев', suite),
      button(
        'Запустить оценку A/B',
        () =>
          invokeOperation(
            'evaluation',
            'run',
            { suite: suite.value },
            'Запустить серию с настоящей моделью',
          ),
        'primary',
      ),
    );
    view.append(header);
  }
  if (!actions.includes('list')) return view;
  view.append(button('Обновить список', () => openPanel('evaluation')));
  const payload = await api('/api/evaluation/list', {});
  const entries = payload.runs || payload.items || (Array.isArray(payload) ? payload : []);
  for (const entry of entries) {
    const id = entry.id || entry.runId;
    const node = card(
      entry.title || entry.suite || id,
      `${entry.status || ''} · ${entry.completedTrials ?? 0}/${entry.totalTrials ?? '—'}`,
    );
    if (entry.error) node.append(el('p', '', entry.error));
    node.append(detail('Запуск', entry));
    if (id && actions.includes('report'))
      node.append(
        button('Открыть отчёт', () =>
          invokeOperation('evaluation', 'report', { id }, 'Открыть отчёт'),
        ),
      );
    view.append(node);
  }
  if (!entries.length) view.append(el('p', '', 'Сохранённых запусков нет.'));
  return view;
}

async function invokeOperation(group, action, parameters, title) {
  if (action !== 'report' && !window.confirm(`${title}?`)) return;
  try {
    const result = await api(`/api/${group}/${action}`, parameters);
    if (group === 'market' || group === 'mcp') state.inventory = await api('/api/inventory');
    await openPanel(group);
    if (action === 'report')
      panelContent.prepend(
        result.content ? el('pre', '', result.content) : el('p', '', 'Отчёт пока не сформирован.'),
      );
    if (result !== undefined) panelContent.prepend(detail('Результат операции', result));
    if (action !== 'report') notice('Операция принята');
  } catch (error) {
    notice(error, true);
  }
}

async function openPanel(name) {
  if (!panelNames[name]) return;
  const version = ++state.panelVersion;
  byId('panel-title').textContent = panelNames[name];
  panelContent.replaceChildren(el('p', '', 'Загрузка…'));
  if (!panel.open) panel.showModal();
  const run = selected();
  const views = {
    settings: settingsView,
    inventory: inventoryView,
    files: fileView,
    logs: logsView,
    plan: () => planView(run),
    diff: () => diffView(run),
    stats: statsView,
    doctor: doctorView,
    evaluation: evaluationView,
    market: marketView,
    mcp: mcpView,
  };
  try {
    const view = await views[name]();
    if (version === state.panelVersion) panelContent.replaceChildren(view);
  } catch (error) {
    if (version === state.panelVersion) panelContent.replaceChildren(el('p', '', error.message));
  }
}

function showModel() {
  const model = state.settings;
  byId('model-name').textContent = model.model
    ? `${model.provider} / ${model.model}`
    : 'Настройте модель';
  byId('model-name').title = model.reasoningEffort
    ? `Thinking: ${model.reasoningEffort}`
    : 'Thinking: по умолчанию';
}

byId('new-session').addEventListener('click', () => {
  void selectSession(null);
  byId('sidebar').classList.remove('open');
  prompt.focus();
});
byId('show-inspector').addEventListener('click', () => byId('inspector').classList.toggle('open'));
byId('close-inspector').addEventListener('click', () => byId('inspector').classList.remove('open'));
byId('show-sessions').addEventListener('click', () => byId('sidebar').classList.toggle('open'));
byId('close-panel').addEventListener('click', () => panel.close());
byId('clear-draft').addEventListener('click', () => {
  prompt.value = '';
  prompt.focus();
});
byId('mode').addEventListener('change', ({ target }) => {
  state.mode = target.value;
});
byId('run-select').addEventListener('change', ({ target }) => {
  state.run = target.value;
  statusBadge();
  void loadEvents(state.run).catch((error) => notice(error, true));
});
for (const item of document.querySelectorAll('[data-panel]'))
  item.addEventListener('click', () => openPanel(item.dataset.panel));
byId('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text || state.busy) return;
  if (
    ['running', 'awaiting_confirmation', 'awaiting_plan', 'uncertain'].includes(
      state.runs.at(-1)?.status,
    )
  ) {
    notice('Сначала решите ожидающее действие или начните новую сессию', true);
    return;
  }
  prompt.value = '';
  void execute('/api/run', { prompt: text, mode: state.mode, sessionId: state.session });
});
prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    byId('composer').requestSubmit();
  }
});

function watchMarketplace() {
  if (!state.operations.market?.includes('events')) return;
  const openedAt = Date.now() - 15_000;
  const seen = new Set();
  async function poll() {
    try {
      const events = await api('/api/market/events', {});
      const changes = [];
      for (const event of events.reverse()) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        if (!event.next || Date.parse(event.time) < openedAt) continue;
        if (event.type === 'market_skill_discovered')
          changes.push(`Новый скилл ${event.next.name}`);
        if (event.type === 'market_version_discovered')
          changes.push(`Новая версия ${event.next.name}@${event.next.version}`);
        if (event.type === 'market_update' && event.result === 'activated')
          changes.push(`Обновлён ${event.next.name}@${event.next.version}`);
      }
      if (changes.length) notice(changes.join(' · '));
    } catch {
      // Ignore transient errors reading the local journal.
    } finally {
      setTimeout(poll, 5000);
    }
  }
  void poll();
}

async function start() {
  try {
    const data = await api('/api/bootstrap');
    Object.assign(state, data);
    byId('workspace-name').textContent = data.workspace;
    byId('mode').value = state.mode;
    showModel();
    watchMarketplace();
    await selectSession(data.sessionId || data.sessions[0]?.id || null);
  } catch (error) {
    notice(error, true);
    renderEmpty();
  }
}

void start();
