import { describe, expect, it } from 'vitest';
import { EXIT_REASONS, MEDICAL_INSURANCE_CLASSES as FORM_CLASSES } from '@/app/api/employees/_workforce-fields';
import { TERMINATION_REASONS } from '@/lib/settlement';
import {
  EMPLOYEE_EXIT_REASONS,
  EXIT_REASON_TO_TERMINATION,
  MEDICAL_INSURANCE_CLASSES,
  TERMINATION_TO_EXIT_REASON,
  normalizeMedicalClass,
  MEDICAL_PREMIUM_KEYS,
  parseMedicalPremiums,
  serializeMedicalPremiums,
  validateMedicalPremiums,
  resolveTerminationReason,
} from '@/lib/workforce';

describe('lists shared with the employee form (_workforce-fields.ts) stay in sync', () => {
  it('medical insurance classes', () => {
    expect([...MEDICAL_INSURANCE_CLASSES]).toEqual([...FORM_CLASSES]);
  });
  it('exit reasons', () => {
    expect([...EMPLOYEE_EXIT_REASONS]).toEqual([...EXIT_REASONS]);
  });
});

describe('medical class keys', () => {
  it('normalizes exactly VIP, A+, A, B, C', () => {
    expect(normalizeMedicalClass(' a + ')).toBe('A+');
    expect(normalizeMedicalClass('vip')).toBe('VIP');
    expect(normalizeMedicalClass('c')).toBe('C');
    expect(normalizeMedicalClass('Gold')).toBeNull();
    expect(normalizeMedicalClass('A++')).toBeNull();
    expect(normalizeMedicalClass(null)).toBeNull();
  });

  it('company medical premiums (Company.medicalPremiumsJson) accept exactly the classes + DEPENDENT', () => {
    expect([...MEDICAL_PREMIUM_KEYS]).toEqual([...FORM_CLASSES, 'DEPENDENT']);
    expect(parseMedicalPremiums('{"VIP": 12000, "A+": 8000, "a": 6000, "dependent": 900, "Gold": 1, "B": -5}')).toEqual({ VIP: 12000, 'A+': 8000, A: 6000, DEPENDENT: 900 });
    expect(parseMedicalPremiums('not json')).toEqual({});
    expect(serializeMedicalPremiums({ DEPENDENT: 900, VIP: 12000 })).toBe('{"VIP":12000,"DEPENDENT":900}');
    expect(serializeMedicalPremiums({})).toBeNull();
    const bad = validateMedicalPremiums({ VIP: 1, Gold: 2 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('Gold');
    expect(validateMedicalPremiums({ A: -1 }).ok).toBe(false);
    expect(validateMedicalPremiums({ A: 'abc' }).ok).toBe(false);
    expect(validateMedicalPremiums([1, 2]).ok).toBe(false);
    expect(validateMedicalPremiums({ A: '', 'A+': '٨٠٠٠', DEPENDENT: 0 })).toEqual({ ok: true, value: { 'A+': 8000, DEPENDENT: 0 } });
  });
});

describe('exit reason mapping (Employee.exitReason <-> settlement TerminationReason)', () => {
  it('covers every employee exit reason; targets are settlement reasons or null (choice needed)', () => {
    for (const r of EMPLOYEE_EXIT_REASONS) {
      const m = EXIT_REASON_TO_TERMINATION[r];
      expect(m).toBeDefined();
      if (m.terminationReason !== null) expect(TERMINATION_REASONS).toContain(m.terminationReason);
      expect(m.note.length).toBeGreaterThan(0);
    }
    expect(EXIT_REASON_TO_TERMINATION.EMPLOYER_TERMINATION.terminationReason).toBe('COMPANY_TERMINATION');
    expect(EXIT_REASON_TO_TERMINATION.CONTRACT_END.terminationReason).toBe('CONTRACT_EXPIRY');
    expect(EXIT_REASON_TO_TERMINATION.MUTUAL_AGREEMENT.terminationReason).toBeNull();
    expect(EXIT_REASON_TO_TERMINATION.OTHER.terminationReason).toBeNull();
  });

  it('reverse mapping covers every settlement reason with a valid employee reason', () => {
    for (const r of TERMINATION_REASONS) expect(EMPLOYEE_EXIT_REASONS).toContain(TERMINATION_TO_EXIT_REASON[r]);
  });

  it('resolveTerminationReason accepts both lists', () => {
    expect(resolveTerminationReason('RESIGNATION')).toMatchObject({ terminationReason: 'RESIGNATION', certain: true });
    expect(resolveTerminationReason('ARTICLE_81')).toMatchObject({ terminationReason: 'ARTICLE_81', certain: true });
    expect(resolveTerminationReason('RETIREMENT')).toMatchObject({ terminationReason: 'CONTRACT_EXPIRY', certain: false });
    expect(resolveTerminationReason('ABSCONDING')).toMatchObject({ terminationReason: 'ARTICLE_80', certain: false });
    expect(resolveTerminationReason('???').terminationReason).toBeNull();
  });
});
