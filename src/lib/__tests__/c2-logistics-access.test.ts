// WP-8 (council 2): access gates in custody, vehicles, claims and the incoming-requests hub.
import { describe, expect, it } from 'vitest';
import {
  findPlateDuplicate,
  isValidModelYear,
  modelYearMax,
  normalizeDigits,
  normalizePlate,
  vehicleCreateSchema,
  vehicleUpdateSchema,
} from '@/app/api/vehicles/_lib';
import { claimCreateSchema, claimUpdateSchema, faultSharesValid } from '@/app/api/claims/_lib';
import {
  DAMAGE_REASON_MIN,
  SIM_DAMAGE_MESSAGE,
  assetActionSchema,
  assetListQuerySchema,
  isValidDamageReason,
  simAsCustodyItem,
} from '@/app/api/assets/_lib';
import { hasTerminatedEmployee, wantsHeldByTerminated } from '@/app/api/services/_lib';
import { canAccessPath, visibleGroups, visibleHrefs } from '@/lib/menu';
import type { AppRole } from '@/lib/constants';

const NOW = new Date('2026-09-25T09:00:00.000Z');

describe('normalizePlate', () => {
  it('matches the council example: "LF أ ب ج1234" and "LF ا ب ج 1234"', () => {
    expect(normalizePlate('LF أ ب ج1234')).toBe(normalizePlate('LF ا ب ج 1234'));
  });

  it('removes spaces, tatweel and separators', () => {
    expect(normalizePlate('ا ب ح - 1234')).toBe('ابح1234');
    expect(normalizePlate('ا ـ ب ح.1234')).toBe('ابح1234');
    expect(normalizePlate('  ا\tب  ح 1234 ')).toBe('ابح1234');
  });

  it('unifies alef forms (أ إ آ ٱ -> ا), ي -> ى and ة -> ه', () => {
    expect(normalizePlate('أبح1234')).toBe('ابح1234');
    expect(normalizePlate('إبح1234')).toBe('ابح1234');
    expect(normalizePlate('آبح1234')).toBe('ابح1234');
    expect(normalizePlate('يبح1')).toBe(normalizePlate('ىبح1'));
  });

  it('maps the Latin plate letters to their Arabic counterpart (case-insensitive)', () => {
    expect(normalizePlate('A B J 1234')).toBe(normalizePlate('ا ب ح 1234'));
    expect(normalizePlate('abj1234')).toBe(normalizePlate('ا ب ح 1234'));
    expect(normalizePlate('K N V 7')).toBe('كنى7');
    expect(normalizePlate('X T E G L Z H U D R S')).toBe('صطعقلمهودرس');
  });

  it('keeps Latin letters that are not used on Saudi plates', () => {
    expect(normalizePlate('LF 1')).toBe('لF1');
    expect(normalizePlate('W')).toBe('W');
  });

  it('unifies Arabic-Indic and Persian digits', () => {
    expect(normalizeDigits('١٢٣٤')).toBe('1234');
    expect(normalizeDigits('۰۹')).toBe('09');
    expect(normalizePlate('ا ب ح ١٢٣٤')).toBe('ابح1234');
  });

  it('keys a single digits block typed before the letters letters-first', () => {
    expect(normalizePlate('1234 ا ب ح')).toBe(normalizePlate('ا ب ح 1234'));
  });

  it('does not reorder plates with several blocks (non-standard plates)', () => {
    expect(normalizePlate('T-LEGAL-10-x61')).not.toBe(normalizePlate('T-LEGAL-106-x1'));
  });

  it('different plates stay different', () => {
    expect(normalizePlate('ا ب ح 1234')).not.toBe(normalizePlate('ا ب ح 1235'));
    expect(normalizePlate('ا ب ح 1234')).not.toBe(normalizePlate('ا ب د 1234'));
    expect(normalizePlate('')).toBe('');
    expect(normalizePlate(null)).toBe('');
  });
});

describe('findPlateDuplicate', () => {
  const fleet = [
    { id: 'v1', plateNumber: 'LF ا ب ج 1234' },
    { id: 'v2', plateNumber: 'ر س ص 77' },
  ];

  it('finds an existing vehicle whose plate normalises to the same key', () => {
    expect(findPlateDuplicate('LF أ ب ج1234', fleet)?.id).toBe('v1');
    expect(findPlateDuplicate('R S X 77', fleet)?.id).toBe('v2');
  });

  it('ignores the vehicle being edited', () => {
    expect(findPlateDuplicate('LF أ ب ج1234', fleet, 'v1')).toBeUndefined();
  });

  it('returns undefined for a new plate or a blank key', () => {
    expect(findPlateDuplicate('ا ب ح 1', fleet)).toBeUndefined();
    expect(findPlateDuplicate('   ', fleet)).toBeUndefined();
  });
});

describe('model year', () => {
  it('accepts blank and four plausible digits', () => {
    expect(isValidModelYear('', NOW)).toBe(true);
    expect(isValidModelYear('2024', NOW)).toBe(true);
    expect(isValidModelYear('1950', NOW)).toBe(true);
    expect(isValidModelYear('٢٠٢٥', NOW)).toBe(true);
    expect(isValidModelYear(String(modelYearMax(NOW)), NOW)).toBe(true);
  });

  it('rejects text, other lengths and implausible years', () => {
    expect(isValidModelYear('abcd', NOW)).toBe(false);
    expect(isValidModelYear('24', NOW)).toBe(false);
    expect(isValidModelYear('20245', NOW)).toBe(false);
    expect(isValidModelYear('1949', NOW)).toBe(false);
    expect(isValidModelYear(String(modelYearMax(NOW) + 1), NOW)).toBe(false);
    expect(isValidModelYear('2024م', NOW)).toBe(false);
  });

  it('the vehicle schemas validate and normalise modelYear', () => {
    const base = { brand: 'تويوتا', plateNumber: 'ا ب ح 1' };
    expect(vehicleCreateSchema.safeParse({ ...base, modelYear: 'abcd' }).success).toBe(false);
    const ok = vehicleCreateSchema.safeParse({ ...base, modelYear: '٢٠٢٤' });
    expect(ok.success && ok.data.modelYear).toBe('2024');
    const blank = vehicleCreateSchema.safeParse({ ...base, modelYear: null });
    expect(blank.success && blank.data.modelYear).toBe('');
    expect(vehicleCreateSchema.safeParse(base).success).toBe(true);
    expect(vehicleUpdateSchema.safeParse({ modelYear: '1800' }).success).toBe(false);
    expect(vehicleUpdateSchema.safeParse({ color: 'أبيض' }).success).toBe(true);
  });
});

describe('claims: fault shares', () => {
  it('faultSharesValid: sum <= 100, a missing share imposes nothing', () => {
    expect(faultSharesValid(75, 75)).toBe(false);
    expect(faultSharesValid(100, 1)).toBe(false);
    expect(faultSharesValid(75, 25)).toBe(true);
    expect(faultSharesValid(33.3, 66.7)).toBe(true);
    expect(faultSharesValid(100, null)).toBe(true);
    expect(faultSharesValid(undefined, 100)).toBe(true);
  });

  it('create and update schemas reject 75 + 75', () => {
    const create = claimCreateSchema.safeParse({ vehicleId: 'v1', faultPercentageAgainst: 75, faultPercentageFor: 75 });
    expect(create.success).toBe(false);
    if (!create.success) expect(create.error.issues[0].message).toContain('100');
    expect(claimCreateSchema.safeParse({ vehicleId: 'v1', faultPercentageAgainst: 75, faultPercentageFor: 25 }).success).toBe(true);
    expect(claimUpdateSchema.safeParse({ faultPercentageAgainst: '60', faultPercentageFor: '50' }).success).toBe(false);
    expect(claimUpdateSchema.safeParse({ faultPercentageAgainst: 60 }).success).toBe(true);
  });
});

describe('assets: damage reason and terminated holders', () => {
  it('isValidDamageReason needs DAMAGE_REASON_MIN visible characters', () => {
    expect(DAMAGE_REASON_MIN).toBe(5);
    expect(isValidDamageReason(undefined)).toBe(false);
    expect(isValidDamageReason('    ')).toBe(false);
    expect(isValidDamageReason('كسر')).toBe(false);
    expect(isValidDamageReason('كسر الشاشة')).toBe(true);
  });

  it('assetActionSchema requires a reason for damage only', () => {
    expect(assetActionSchema.safeParse({ action: 'damage' }).success).toBe(false);
    expect(assetActionSchema.safeParse({ action: 'damage', reason: 'فقد' }).success).toBe(false);
    const ok = assetActionSchema.safeParse({ action: 'damage', reason: 'فقد الجهاز في الموقع' });
    expect(ok.success && ok.data.reason).toBe('فقد الجهاز في الموقع');
    expect(assetActionSchema.safeParse({ action: 'clear' }).success).toBe(true);
  });

  it('SIM damage message tells the user to cancel the line at the operator', () => {
    expect(SIM_DAMAGE_MESSAGE).toBe('تم فصل الشريحة عن الموظف؛ راجع إلغاء الخط لدى المشغل');
  });

  it('hasTerminatedEmployee', () => {
    expect(hasTerminatedEmployee([])).toBe(false);
    expect(hasTerminatedEmployee([{ isTerminated: false }, { isTerminated: null }])).toBe(false);
    expect(hasTerminatedEmployee([{ isTerminated: false }, { isTerminated: true }])).toBe(true);
  });

  it('heldByTerminated query flag', () => {
    expect(wantsHeldByTerminated('http://x/api/services/telecom?heldByTerminated=1')).toBe(true);
    expect(wantsHeldByTerminated('http://x/api/services/telecom?heldByTerminated=true')).toBe(true);
    expect(wantsHeldByTerminated('http://x/api/services/telecom?heldByTerminated=0')).toBe(false);
    expect(wantsHeldByTerminated('http://x/api/services/telecom')).toBe(false);
    expect(assetListQuerySchema.safeParse({ heldByTerminated: '1' }).success).toBe(true);
    expect(assetListQuerySchema.safeParse({ heldByTerminated: 'yes' }).success).toBe(false);
  });

  it('simAsCustodyItem passes the holder through (for the "منتهي الخدمة" badge)', () => {
    const holder = { id: 'e1', employeeId: 'EMP-1', firstNameArabic: 'سالم', lastNameArabic: 'علي', isTerminated: true };
    const item = simAsCustodyItem({
      id: 's1', employeeId: 'e1', simNumber: '0550000000', plan: null, provider: null, createdAt: NOW, employee: holder,
    });
    expect(item.employee?.isTerminated).toBe(true);
    const bare = simAsCustodyItem({ id: 's1', employeeId: 'e1', simNumber: '1', plan: null, provider: null, createdAt: NOW });
    expect('employee' in bare).toBe(false);
  });
});

describe('menu: PURCHASING_AGENT reaches /incoming-requests only', () => {
  const hrefs = (role: AppRole) => visibleHrefs(role, null);

  it('the purchasing agent sees /incoming-requests and can open it', () => {
    expect(hrefs('PURCHASING_AGENT').has('/incoming-requests')).toBe(true);
    expect(canAccessPath('PURCHASING_AGENT', null, '/incoming-requests')).toBe(true);
  });

  it('but not the archive (its API stays HR + PAYROLL)', () => {
    expect(canAccessPath('PURCHASING_AGENT', null, '/incoming-requests/archive')).toBe(false);
    expect(canAccessPath('HR_MANAGER', null, '/incoming-requests/archive')).toBe(true);
    expect(canAccessPath('FINANCE_MANAGER', null, '/incoming-requests/archive')).toBe(true);
  });

  it('the rest of the purchasing agent menu is unchanged (one new item)', () => {
    const items = visibleGroups('PURCHASING_AGENT', null).flatMap((g) => g.items.map((i) => i.href));
    expect(items.filter((h) => h === '/incoming-requests')).toHaveLength(1);
    expect(items).not.toContain('/payments');
    expect(items).not.toContain('/renewals');
    expect(items).not.toContain('/loans');
  });

  it('other roles are unaffected', () => {
    expect(hrefs('HR_MANAGER').has('/incoming-requests')).toBe(true);
    expect(hrefs('GOV_RELATIONS').has('/incoming-requests')).toBe(false);
    expect(hrefs('EMPLOYEE').has('/incoming-requests')).toBe(false);
    expect(canAccessPath('GOV_RELATIONS', null, '/incoming-requests')).toBe(false);
  });
});
