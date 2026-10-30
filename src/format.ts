/**
 * Server timestamps are UTC. New rows are ISO-8601 ("2026-10-30T12:00:00.000Z"),
 * but older SQLite rows hold "2026-10-30 12:00:00" with no zone, which browsers
 * would read as local time — showing it hours off.
 */
export function parseServerDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: string | null | undefined, fallback = 'Never'): string {
  return parseServerDate(value)?.toLocaleString() ?? fallback;
}
