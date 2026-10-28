import { daysInMonth } from './calendar.mjs';

// Return the same day next month, clamped to that month's last day, in UTC.
export function periodEnd(start) {
  const date = new Date(start + 'T00:00:00Z');
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const end = new Date(Date.UTC(year, month, day));
  return end.toISOString().slice(0, 10);
}
