import { describe, expect, it } from 'vitest';
import {
  clinicTimeToInstant,
  dayOfWeek,
  formatDateOnly,
  isValidDateString,
  isValidTimeString,
  minutesToTime,
  parseDateOnly,
  slotRange,
  timeToMinutes,
} from '../../src/lib/time';

describe('date and time parsing', () => {
  it('accepts real calendar dates and rejects impossible ones', () => {
    expect(isValidDateString('2026-02-28')).toBe(true);
    expect(isValidDateString('2024-02-29')).toBe(true);
    expect(isValidDateString('2026-02-30')).toBe(false);
    expect(isValidDateString('2026-13-01')).toBe(false);
    expect(isValidDateString('26-01-01')).toBe(false);
  });

  it('validates 24-hour times', () => {
    expect(isValidTimeString('00:00')).toBe(true);
    expect(isValidTimeString('23:59')).toBe(true);
    expect(isValidTimeString('24:00')).toBe(false);
    expect(isValidTimeString('09:60')).toBe(false);
    expect(isValidTimeString('9:00')).toBe(false);
  });

  it('round-trips a date through UTC midnight without drifting a day', () => {
    const parsed = parseDateOnly('2026-03-15');
    expect(parsed.toISOString()).toBe('2026-03-15T00:00:00.000Z');
    expect(formatDateOnly(parsed)).toBe('2026-03-15');
  });

  it('reads weekday in UTC', () => {
    expect(dayOfWeek(parseDateOnly('2026-08-23'))).toBe(0);
    expect(dayOfWeek(parseDateOnly('2026-08-24'))).toBe(1);
  });

  it('converts between minutes and HH:MM', () => {
    expect(timeToMinutes('09:30')).toBe(570);
    expect(minutesToTime(570)).toBe('09:30');
    expect(minutesToTime(0)).toBe('00:00');
  });
});

describe('slotRange', () => {
  it('splits a window into whole slots', () => {
    expect(slotRange('09:00', '11:00', 30)).toEqual([
      { startTime: '09:00', endTime: '09:30' },
      { startTime: '09:30', endTime: '10:00' },
      { startTime: '10:00', endTime: '10:30' },
      { startTime: '10:30', endTime: '11:00' },
    ]);
  });

  it('drops a trailing partial slot that would overrun closing time', () => {
    const slots = slotRange('09:00', '10:20', 30);
    expect(slots).toHaveLength(2);
    expect(slots.at(-1)!.endTime).toBe('10:00');
  });

  it('returns nothing when the window is shorter than one slot', () => {
    expect(slotRange('09:00', '09:20', 30)).toEqual([]);
  });
});

describe('clinicTimeToInstant', () => {
  it('treats wall-clock time as UTC when the clinic runs in UTC', () => {
    expect(clinicTimeToInstant('2026-06-15', '14:30', 'UTC').toISOString()).toBe(
      '2026-06-15T14:30:00.000Z'
    );
  });

  it('applies a fixed offset zone correctly', () => {
    expect(clinicTimeToInstant('2026-06-15', '14:30', 'Asia/Kolkata').toISOString()).toBe(
      '2026-06-15T09:00:00.000Z'
    );
  });

  it('resolves the same wall-clock time differently either side of a DST change', () => {
    const winter = clinicTimeToInstant('2026-01-15', '12:00', 'America/New_York');
    const summer = clinicTimeToInstant('2026-07-15', '12:00', 'America/New_York');
    expect(winter.toISOString()).toBe('2026-01-15T17:00:00.000Z');
    expect(summer.toISOString()).toBe('2026-07-15T16:00:00.000Z');
  });
});
