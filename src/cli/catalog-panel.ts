import { EditorBuffer, type EditorKey } from './editor.js';

export interface CatalogEntry {
  id: string;
  enabled: boolean;
  state: string;
  detail: string;
}

export interface CatalogSource {
  list(): CatalogEntry[];
  toggle(entry: CatalogEntry): void | Promise<void>;
  refresh?(): void | Promise<void>;
  toggleAll?(): void | Promise<void>;
  subtitle?(): string;
}

export class CatalogPanel {
  private readonly search = new EditorBuffer();
  private selected = 0;
  private first = 0;
  private pageSize = 10;
  private busy = false;
  private pasting = false;
  private notice = '';
  private entries: CatalogEntry[];
  private subtitle?: string;

  constructor(
    readonly title: 'Skills' | 'MCP',
    private readonly source: CatalogSource,
    private readonly changed: () => void,
    private readonly close: () => void,
    private readonly writable: () => boolean,
  ) {
    this.entries = source.list();
    this.subtitle = source.subtitle?.();
  }

  view(pageSize: number) {
    this.pageSize = Math.max(1, pageSize);
    const entries = this.filtered();
    const selected = Math.min(this.selected, Math.max(0, entries.length - 1));
    const first = (this.first = Math.max(
      0,
      Math.min(
        selected,
        entries.length - this.pageSize,
        Math.max(this.first, selected - this.pageSize + 1),
      ),
    ));
    return {
      title: this.title,
      subtitle: this.subtitle,
      query: this.search.view(),
      entries: entries.slice(first, first + this.pageSize),
      index: selected - first,
      selected: entries[selected],
      position: entries.length ? selected + 1 : 0,
      count: entries.length,
      notice: this.busy
        ? 'Применяю изменения…'
        : this.notice || (this.writable() ? '' : 'Просмотр · запуск ждёт решения.'),
      keys: [
        '↑↓ выбор',
        'Enter вкл./выкл.',
        ...(this.source.refresh ? ['Ctrl+R проверка'] : []),
        ...(this.source.toggleAll ? ['Ctrl+E каталог'] : []),
        'Esc назад',
      ].join(' · '),
    };
  }

  key(value: string | undefined, key: EditorKey): void {
    if (key.name === 'paste-start') this.pasting = true;
    if (this.pasting) {
      if (key.name === 'paste-end') this.pasting = false;
      this.searchKey(value, key);
      return;
    }
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      if (!this.busy) this.close();
      return;
    }
    if (
      key.name === 'up' ||
      key.name === 'down' ||
      key.name === 'pageup' ||
      key.name === 'pagedown'
    ) {
      const distance = key.name.startsWith('page') ? this.pageSize : 1;
      const direction = key.name.endsWith('up') ? -1 : 1;
      this.selected = Math.max(
        0,
        Math.min(this.filtered().length - 1, this.selected + distance * direction),
      );
      this.changed();
      return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      const entry = this.filtered()[this.selected];
      if (entry) this.run(() => this.source.toggle(entry));
      return;
    }
    if (key.ctrl && key.name === 'r' && this.source.refresh) {
      this.run(this.source.refresh, 'Проверка завершена.');
      return;
    }
    if (key.ctrl && key.name === 'e' && this.source.toggleAll) {
      this.run(this.source.toggleAll);
      return;
    }
    this.searchKey(value, key);
  }

  private filtered() {
    const terms = this.search.view().text.trim().toLowerCase().split(/\s+/u);
    return this.entries.filter((entry) => {
      const searchable = `${entry.id} ${entry.state} ${entry.detail}`.toLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
  }

  private searchKey(value: string | undefined, key: EditorKey) {
    const previous = this.search.view().text;
    if (this.search.key(value, key)?.type !== 'change') return;
    if (previous !== this.search.view().text) {
      this.selected = 0;
      this.first = 0;
    }
    this.changed();
  }

  private run(action: () => void | Promise<void>, success = '') {
    if (this.busy) return;
    if (!this.writable()) {
      this.notice = 'Сначала завершите ожидающий запуск.';
      this.changed();
      return;
    }
    this.busy = true;
    this.notice = '';
    this.changed();
    void Promise.resolve()
      .then(action)
      .then(() => {
        this.entries = this.source.list();
        this.subtitle = this.source.subtitle?.();
        this.notice = success;
      })
      .catch((error: unknown) => {
        this.notice = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.selected = Math.max(0, Math.min(this.selected, this.filtered().length - 1));
        this.busy = false;
        this.changed();
      });
  }
}
