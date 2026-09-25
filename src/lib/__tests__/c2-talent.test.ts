// WP-5 (DOM-007, HR-09): evaluation without generated scores; recruitment offer separated from notes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as scoring from '@/app/api/evaluations/scoring';
import { buildOfferEmail } from '@/app/api/recruitment/shared';
import {
  DEFAULT_TEMPLATE_SECTIONS,
  bucketScores,
  checkScores,
  computeTotalScore,
  ratingForScore,
  weightsAreValid,
  type ScoringSection,
} from '@/app/api/evaluations/scoring';

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const sections: ScoringSection[] = [
  { weight: 60, items: [{ id: 'a1' }, { id: 'a2' }] },
  { weight: 40, items: [{ id: 'b1' }, { id: 'b2', isRequired: false }] },
];

describe('evaluation scoring (unchanged by WP-5)', () => {
  it('computes the weighted total out of 100', () => {
    const all5 = ['a1', 'a2', 'b1', 'b2'].map((itemId) => ({ itemId, score: 5 }));
    expect(computeTotalScore(sections, all5)).toBe(100);
    // section A avg 4 -> 80% * 60 = 48; section B avg 3 -> 60% * 40 = 24
    expect(
      computeTotalScore(sections, [
        { itemId: 'a1', score: 5 },
        { itemId: 'a2', score: 3 },
        { itemId: 'b1', score: 3 },
      ]),
    ).toBe(72);
    expect(computeTotalScore(sections, [])).toBe(0);
    // Rounded to two decimals: A avg 11/3 -> 73.333% * 60 = 44
    expect(computeTotalScore([{ weight: 60, items: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] }], [
      { itemId: 'x', score: 4 },
      { itemId: 'y', score: 4 },
      { itemId: 'z', score: 3 },
    ])).toBe(44);
  });

  it('maps totals to the same ratings', () => {
    expect(ratingForScore(95)).toBe('ممتاز');
    expect(ratingForScore(90)).toBe('ممتاز');
    expect(ratingForScore(89.99)).toBe('جيد جداً');
    expect(ratingForScore(80)).toBe('جيد جداً');
    expect(ratingForScore(70)).toBe('جيد');
    expect(ratingForScore(60)).toBe('مقبول');
    expect(ratingForScore(59.99)).toBe('ضعيف');
    expect(bucketScores([95, 85, 75, 65, 10])).toEqual({ excellent: 1, veryGood: 1, good: 1, acceptable: 1, weak: 1 });
  });

  it('keeps score validation and default template weights', () => {
    const check = checkScores(sections, [
      { itemId: 'a1', score: 6 },
      { itemId: 'a1', score: 3 },
      { itemId: 'zz', score: 3 },
    ]);
    expect(check.outOfRangeItemIds).toEqual(['a1']);
    expect(check.duplicateItemIds).toEqual(['a1']);
    expect(check.unknownItemIds).toEqual(['zz']);
    expect(check.missingRequiredItemIds).toEqual(['a2', 'b1']);
    expect(weightsAreValid(DEFAULT_TEMPLATE_SECTIONS.map((s) => s.weight))).toBe(true);
  });
});

describe('DOM-007: no generated evaluation scores', () => {
  it('scoring no longer exports suggestScores (leave-day and tenure penalties)', () => {
    expect('suggestScores' in scoring).toBe(false);
  });

  it('the API answers view=smart-suggest with 410 and queries no leaves for it', () => {
    const route = src('app/api/evaluations/route.ts');
    expect(route).toMatch(/view === 'smart-suggest'\)[\s\S]{0,400}new HttpError\(410,/);
    expect(route).not.toMatch(/prisma\.leave\./);
    expect(route).not.toMatch(/suggestScores/);
  });

  it('the evaluation page has no "smart" assistant and links to the attendance record', () => {
    const page = src('app/evaluations/[id]/page.tsx');
    expect(page).not.toContain('ذكي');
    expect(page).not.toContain('smart-suggest');
    expect(page).toContain('سجل حضور الموظف');
    expect(page).toContain('view=attendance-record');
  });
});

describe('HR-09: offer text separated from internal notes', () => {
  const route = src('app/api/applications/route.ts');
  const page = src('app/applications/page.tsx');

  it('the offer e-mail is built from offerText only, never from notes', () => {
    expect(route).toContain('offerDetails: offerForCandidate');
    expect(route).not.toMatch(/offerDetails:\s*updated\.notes/);
    expect(route).toMatch(/status === APPLICATION_STATUS\.OFFERED && !offerText[\s\S]{0,80}badRequest/);
  });

  it('the prepared e-mail carries the offer text and nothing from the internal notes', () => {
    const offerText = 'الراتب الأساسي 4000 ر.س، بدل سكن 1000 ر.س';
    const internal = 'حد الميزانية 6000 - تقييم المقابلة متوسط';
    const { html, subject } = buildOfferEmail({ candidateName: 'مرشح', jobTitle: 'محاسب', departmentName: 'المالية', offerDetails: offerText });
    expect(html).toContain('4000 ر.س');
    expect(html).not.toContain(internal);
    expect(html).not.toContain('الراتب المتوقع');
    expect(subject).toBe('عرض وظيفي: محاسب');
  });

  it('stage notes are appended to the existing notes, not written over them', () => {
    expect(route).toContain('appendNoteEntries(current.notes');
    expect(route).not.toMatch(/data\.notes = notes;/);
  });

  it('the status dialog is not pre-filled from the stored notes and previews the offer', () => {
    expect(page).not.toMatch(/notes:\s*app\.notes\s*\|\|/);
    expect(page).toContain('معاينة العرض');
    expect(page).toContain('offerText: isOffer ? statusForm.offerText : undefined');
  });

  it('the page recognises exactly the log-line header the API writes', () => {
    // Route header: `[${YYYY-MM-DD HH:mm} · ${author} · ${stage}]`; page regex must match it so the
    // card headline never shows an HR log line as if the candidate wrote it.
    const regexSource = /const NOTE_LOG_LINE = \/(.+)\/;/.exec(page)?.[1];
    expect(regexSource).toBeTruthy();
    const logLine = new RegExp(regexSource as string);
    expect(logLine.test('[2026-09-25 14:05 · سارة · مقابلة] ملاحظة')).toBe(true);
    expect(logLine.test('الراتب المتوقع: 4500 ر.س')).toBe(false);
    expect(route).toContain('const header = `[${riyadhStamp(now)} · ${safeAuthor} · ${STAGE_LABELS[stage]}]`;');
  });
});
