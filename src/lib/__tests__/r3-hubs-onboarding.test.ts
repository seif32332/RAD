import { describe, expect, it } from 'vitest';
import {
  NATIONALITY_REVIEW_LABEL,
  UNSPECIFIED_NON_SAUDI_NATIONALITY,
  onboardingDataReviewNote,
  onboardingNationality,
  onboardingPlaceholderFields,
  onboardingPlaceholderLabels,
} from '@/app/api/incoming-requests/_lib';
import { DEFAULT_NATIONALITY } from '@/lib/employee';

const d = new Date('2026-01-01T00:00:00Z');

describe('onboardingPlaceholderFields', () => {
  it('lists missing required dates in canonical order', () => {
    expect(onboardingPlaceholderFields({})).toEqual(['dateOfBirth', 'iqamaOrIdExp', 'joinDate']);
    expect(onboardingPlaceholderFields({ dateOfBirth: d, iqamaOrIdExp: null, joinDate: undefined })).toEqual(['iqamaOrIdExp', 'joinDate']);
    expect(onboardingPlaceholderFields({ dateOfBirth: d, iqamaOrIdExp: d, joinDate: d })).toEqual([]);
  });
  it('treats an invalid Date as missing', () => {
    expect(onboardingPlaceholderFields({ dateOfBirth: new Date('x'), iqamaOrIdExp: d, joinDate: d })).toEqual(['dateOfBirth']);
  });
});

describe('onboardingPlaceholderLabels', () => {
  it('maps to Arabic labels in canonical order regardless of input order', () => {
    expect(onboardingPlaceholderLabels(['joinDate', 'dateOfBirth'])).toEqual(['تاريخ الميلاد', 'تاريخ المباشرة']);
    expect(onboardingPlaceholderLabels([])).toEqual([]);
  });
});

describe('onboardingDataReviewNote', () => {
  it('is null when nothing is missing', () => {
    expect(onboardingDataReviewNote([])).toBeNull();
    expect(onboardingDataReviewNote([], ['', ''])).toBeNull();
  });
  it('lists the missing fields', () => {
    const note = onboardingDataReviewNote(['dateOfBirth', 'joinDate']);
    expect(note).toContain('تاريخ الميلاد');
    expect(note).toContain('تاريخ المباشرة');
    expect(note).not.toContain('الهوية');
    expect(note).toMatch(/تاريخ الميلاد، تاريخ المباشرة$/);
  });
  it('appends extra labels (nationality)', () => {
    const note = onboardingDataReviewNote(['iqamaOrIdExp'], [NATIONALITY_REVIEW_LABEL]);
    expect(note).toMatch(/تاريخ انتهاء الهوية \/ الإقامة، الجنسية$/);
    expect(onboardingDataReviewNote([], [NATIONALITY_REVIEW_LABEL])).toMatch(/: الجنسية$/);
  });
});

describe('onboardingNationality', () => {
  it('maps Saudi aliases to the Arabic default (never the legacy "SAUDI")', () => {
    for (const v of ['SAUDI', 'saudi', ' Saudi Arabia ', 'سعودي', 'سعودية']) {
      expect(onboardingNationality(v)).toEqual({ nationality: DEFAULT_NATIONALITY, needsReview: false });
    }
  });
  it('never assumes Saudi for a blank value (GOSI would be deducted silently): flags it for review', () => {
    for (const v of [undefined, null, '', '   ', 42]) {
      expect(onboardingNationality(v)).toEqual({ nationality: UNSPECIFIED_NON_SAUDI_NATIONALITY, needsReview: true });
    }
  });
  it('flags the legacy non-specific non-Saudi value for review', () => {
    for (const v of ['NON_SAUDI', 'non_saudi', 'غير سعودي', 'غير محدد']) {
      expect(onboardingNationality(v)).toEqual({ nationality: UNSPECIFIED_NON_SAUDI_NATIONALITY, needsReview: true });
    }
  });
  it('keeps a real nationality (trimmed)', () => {
    expect(onboardingNationality('  مصري ')).toEqual({ nationality: 'مصري', needsReview: false });
  });
});
