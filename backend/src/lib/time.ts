export const CLINIC_TIMEZONE = process.env.CLINIC_TIMEZONE ?? 'UTC';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidDateString(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
  );
}

export function isValidTimeString(value: string): boolean {
  return TIME_RE.test(value);
}

/** Parses "YYYY-MM-DD" to the UTC midnight Date that Prisma's @db.Date round-trips. */
export function parseDateOnly(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 0=Sunday..6=Saturday, read in UTC so it matches how @db.Date values are stored. */
export function dayOfWeek(date: Date): number {
  return date.getUTCDay();
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const hour = get('hour') % 24;

  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    hour,
    get('minute'),
    get('second')
  );
  return asUtc - instant.getTime();
}

/**
 * Resolves a wall-clock date+time in the clinic's timezone to a real instant.
 * Offset is resolved twice because the first guess can land on the wrong side
 * of a DST transition.
 */
export function clinicTimeToInstant(
  dateString: string,
  timeString: string,
  timeZone: string = CLINIC_TIMEZONE
): Date {
  const [y, m, d] = dateString.split('-').map(Number);
  const [hh, mm] = timeString.split(':').map(Number);
  const wallClock = Date.UTC(y, m - 1, d, hh, mm);

  const firstOffset = zoneOffsetMs(new Date(wallClock), timeZone);
  let instant = wallClock - firstOffset;

  const secondOffset = zoneOffsetMs(new Date(instant), timeZone);
  if (secondOffset !== firstOffset) instant = wallClock - secondOffset;

  return new Date(instant);
}

export function slotRange(
  startTime: string,
  endTime: string,
  slotMinutes: number
): { startTime: string; endTime: string }[] {
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  const slots: { startTime: string; endTime: string }[] = [];

  for (let cursor = start; cursor + slotMinutes <= end; cursor += slotMinutes) {
    slots.push({
      startTime: minutesToTime(cursor),
      endTime: minutesToTime(cursor + slotMinutes),
    });
  }
  return slots;
}
