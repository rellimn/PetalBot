const two = (value: number): string => String(value).padStart(2, '0');

/** Local time as HH:MM:SS.mmm (log and event lists). */
export function formatTime(ms: number): string {
  const date = new Date(ms);
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(
    date.getMilliseconds(),
  ).padStart(3, '0')}`;
}

export const hasData = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  !(typeof value === 'object' && Object.keys(value).length === 0);
