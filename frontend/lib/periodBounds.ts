/**
 * AssistMe - periodBounds utility
 * Location: /frontend/lib/periodBounds.ts
 * Created: Aug 2026 (Balance Sheet tab, subtask 2)
 *
 * Extracted from settings/gst-filing.tsx -- these are pure, stateless
 * date-boundary functions (no screen dependency), safe to share without
 * touching the proven, working GST Filing screen at all. Quarter
 * boundaries follow the Indian financial year (Apr-Mar), NOT calendar
 * quarters -- verified against real FY-rollover edge cases when first
 * built for GST Filing.
 */

export interface PeriodBounds {
  start: Date;
  end: Date;
  label: string;
}

export function getMonthBounds(refDate: Date): PeriodBounds {
  const start = new Date(refDate.getFullYear(), refDate.getMonth(), 1);
  const end = new Date(refDate.getFullYear(), refDate.getMonth() + 1, 0);
  const label = start.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  return { start, end, label };
}

export function getFYQuarterBounds(refDate: Date): PeriodBounds {
  const month = refDate.getMonth();
  const year = refDate.getFullYear();
  const fyStartYear = month >= 3 ? year : year - 1;
  const quarterIndex = Math.floor(((month - 3 + 12) % 12) / 3);
  const quarterStartMonth = (3 + quarterIndex * 3) % 12;
  const quarterStartYear = quarterStartMonth >= 3 ? fyStartYear : fyStartYear + 1;
  const start = new Date(quarterStartYear, quarterStartMonth, 1);
  const end = new Date(quarterStartYear, quarterStartMonth + 3, 0);
  const fyLabel = `FY ${fyStartYear}-${(fyStartYear + 1).toString().slice(-2)}`;
  const label = `Q${quarterIndex + 1} ${fyLabel} (${start.toLocaleDateString('en-IN', { month: 'short' })}-${end.toLocaleDateString('en-IN', { month: 'short' })})`;
  return { start, end, label };
}
