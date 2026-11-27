import type { UsageSummary, UsageTotal } from '../runtime/types.js';
import type { DoctorReport, Frequency } from './index.js';

function quantity(total: UsageTotal): string {
  if (total.total === null) return 'unknown';
  if (total.status === 'partial')
    return `${total.total} (${total.known}/${total.requests} запросов)`;
  return String(total.total);
}

function usage(totals: UsageSummary): string {
  return `вход ${quantity(totals.input)} · выход ${quantity(totals.output)} · кэш ${quantity(totals.cached)} · рассуждения ${quantity(totals.reasoning)}`;
}

function counts(values: Record<string, number>): string {
  return (
    Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => `${name} ×${count}`)
      .join(' · ') || '—'
  );
}

function frequency(values: Frequency): string[] {
  return [
    `  Инструменты · ${counts(values.tools)}`,
    `  Загрузки скиллов · ${counts(values.skills)}`,
    `  Начатые вызовы MCP · ${counts(values.mcp)}`,
  ];
}

export function renderDoctor(report: DoctorReport): string {
  const lines = [
    `Доктор · сессия ${report.session_id}`,
    `Агент · запросов ${report.agent.requests} · ${usage(report.agent.usage)}`,
    ...frequency(report.agent.frequency),
    'Доктор · 0 запросов · вход 0 · выход 0',
  ];
  for (const run of report.runs) {
    lines.push(
      '',
      `Запуск ${run.run_id} · ${run.status} · событий ${run.events}`,
      `  Запросов ${run.requests} · ${usage(run.usage)}`,
      ...frequency(run.frequency),
    );
    for (const finding of run.findings) {
      lines.push(
        `  ! ${finding.interpretation}`,
        `    ${counts(finding.counts)} · события ${finding.event_ids.join(', ')}`,
        `    ${finding.suggestion}`,
      );
    }
    if (!run.findings.length) lines.push('  Правила не нашли совпадений в доступных событиях.');
    lines.push(...run.limitations.map((text) => `  Ограничение · ${text}`));
  }
  lines.push(...report.limitations.map((text) => `Ограничение · ${text}`));
  return lines.join('\n');
}
