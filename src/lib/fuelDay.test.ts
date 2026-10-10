import { describe, expect, it } from 'vitest';
import { addDays, dayLabel, defaultFuelDate, proteinTargetG } from './fuelDay';

describe('defaultFuelDate', () => {
  it('is yesterday before 15:00 and today from 15:00', () => {
    expect(defaultFuelDate(new Date(2026, 9, 2, 14, 59))).toBe('2026-10-01');
    expect(defaultFuelDate(new Date(2026, 9, 2, 15, 0))).toBe('2026-10-02');
    expect(defaultFuelDate(new Date(2026, 9, 2, 0, 30))).toBe('2026-10-01'); // late-night check-in
  });
  it('crosses month and year ends', () => {
    expect(defaultFuelDate(new Date(2026, 10, 1, 8, 0))).toBe('2026-10-31');
    expect(defaultFuelDate(new Date(2027, 0, 1, 8, 0))).toBe('2026-12-31');
  });
  it('is a calendar day across clock changes (23- and 25-hour days)', () => {
    expect(defaultFuelDate(new Date(2026, 9, 26, 0, 30))).toBe('2026-10-25'); // UK clocks go back 25 Oct
    expect(defaultFuelDate(new Date(2026, 2, 30, 0, 30))).toBe('2026-03-29'); // UK clocks go forward 29 Mar
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(addDays('2026-03-29', -1)).toBe('2026-03-28');
  });
});

describe('dayLabel', () => {
  const now = new Date(2026, 9, 2, 9, 0);
  it('names today and yesterday', () => {
    expect(dayLabel('2026-10-02', now)).toBe('Today');
    expect(dayLabel('2026-10-01', now)).toBe('Yesterday');
    expect(dayLabel('2026-09-28', now)).toMatch(/28/);
  });
});

describe('proteinTargetG', () => {
  it('is 1.6 g/kg rounded to 5 g', () => {
    expect(proteinTargetG(1.6, 82.4, 'kg')).toBe(130);
    expect(proteinTargetG(1.6, 100, 'kg')).toBe(160);
  });
  it('converts a bodyweight in lb', () => {
    expect(proteinTargetG(1.6, 181.7, 'lb')).toBe(130);
  });
  it('has no target without a bodyweight', () => {
    expect(proteinTargetG(1.6, null, 'kg')).toBeNull();
    expect(proteinTargetG(1.6, 0, 'kg')).toBeNull();
  });
});
