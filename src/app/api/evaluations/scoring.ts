// Performance-evaluation domain constants and pure scoring helpers (no prisma, unit-testable).

export const EVAL_STATUS = {
  DRAFT: 'DRAFT',
  PENDING_MANAGER: 'PENDING_MANAGER',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  RETURNED: 'RETURNED',
  PENDING_EMPLOYEE_ACK: 'PENDING_EMPLOYEE_ACK',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
} as const;
export type EvalStatus = (typeof EVAL_STATUS)[keyof typeof EVAL_STATUS];

/** Statuses in which the manager may still (re)score the evaluation. */
export const EVAL_EDITABLE_STATUSES: readonly EvalStatus[] = [EVAL_STATUS.DRAFT, EVAL_STATUS.PENDING_MANAGER, EVAL_STATUS.RETURNED];

export const CYCLE_STATUS = { OPEN: 'OPEN', IN_PROGRESS: 'IN_PROGRESS', CLOSED: 'CLOSED' } as const;

export const APPROVAL_ACTION = { APPROVE: 'APPROVE', RETURN: 'RETURN' } as const;

export const RECOMMENDATIONS = [
  'NO_ACTION',
  'BONUS',
  'PROMOTION',
  'RAISE',
  'TRAINING',
  'WARNING',
  'NOTICE',
  'EXTEND_MONITORING',
  'NO_RENEWAL',
  'TERMINATION',
  'OTHER',
] as const;

export const TEMPLATE_TARGET_TYPES = ['GENERAL', 'OPERATIONAL', 'LEADERSHIP', 'CUSTOM'] as const;
export const EVAL_PERIOD_TYPES = ['MONTHLY', 'QUARTERLY', 'ANNUAL', 'PROBATION'] as const;

export const SCORE_MIN = 1;
export const SCORE_MAX = 5;

export interface ScoringSection {
  weight: number;
  items: ReadonlyArray<{ id: string; isRequired?: boolean }>;
}

export interface ItemScoreInput {
  itemId: string;
  score: number;
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Weighted total out of 100: for each section, the average of its scored items (1..5)
 * as a percentage, times the section weight. Sections without scores contribute 0.
 */
export function computeTotalScore(sections: readonly ScoringSection[], scores: readonly ItemScoreInput[]): number {
  const byItem = new Map(scores.map((s) => [s.itemId, s.score]));
  let total = 0;
  for (const section of sections) {
    const values = section.items.map((i) => byItem.get(i.id)).filter((v): v is number => typeof v === 'number');
    if (values.length === 0) continue;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    total += ((avg / SCORE_MAX) * 100 * section.weight) / 100;
  }
  return round2(total);
}

export function ratingForScore(total: number): string {
  if (total >= 90) return 'ممتاز';
  if (total >= 80) return 'جيد جداً';
  if (total >= 70) return 'جيد';
  if (total >= 60) return 'مقبول';
  return 'ضعيف';
}

export interface ScoreCheck {
  /** itemIds that are not part of the evaluation's template. */
  unknownItemIds: string[];
  /** itemIds sent more than once. */
  duplicateItemIds: string[];
  /** Required template items without a score. */
  missingRequiredItemIds: string[];
  /** Scores outside SCORE_MIN..SCORE_MAX or not integers. */
  outOfRangeItemIds: string[];
}

export function checkScores(sections: readonly ScoringSection[], scores: readonly ItemScoreInput[]): ScoreCheck {
  const known = new Set<string>();
  const required: string[] = [];
  for (const s of sections) {
    for (const i of s.items) {
      known.add(i.id);
      if (i.isRequired !== false) required.push(i.id);
    }
  }
  const seen = new Set<string>();
  const unknownItemIds: string[] = [];
  const duplicateItemIds: string[] = [];
  const outOfRangeItemIds: string[] = [];
  for (const s of scores) {
    if (!known.has(s.itemId)) unknownItemIds.push(s.itemId);
    if (seen.has(s.itemId)) duplicateItemIds.push(s.itemId);
    seen.add(s.itemId);
    if (!Number.isInteger(s.score) || s.score < SCORE_MIN || s.score > SCORE_MAX) outOfRangeItemIds.push(s.itemId);
  }
  const missingRequiredItemIds = required.filter((id) => !seen.has(id));
  return { unknownItemIds, duplicateItemIds, missingRequiredItemIds, outOfRangeItemIds };
}

/** Sum of section weights must be 100 (tolerates float noise). */
export function weightsAreValid(weights: readonly number[]): boolean {
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.every((w) => Number.isFinite(w) && w > 0) && Math.abs(sum - 100) < 0.01;
}

export interface ScoreBuckets {
  excellent: number;
  veryGood: number;
  good: number;
  acceptable: number;
  weak: number;
}

export function bucketScores(totals: readonly number[]): ScoreBuckets {
  const b: ScoreBuckets = { excellent: 0, veryGood: 0, good: 0, acceptable: 0, weak: 0 };
  for (const t of totals) {
    if (t >= 90) b.excellent++;
    else if (t >= 80) b.veryGood++;
    else if (t >= 70) b.good++;
    else if (t >= 60) b.acceptable++;
    else b.weak++;
  }
  return b;
}

// DOM-007 (WP-5): the generated "smart suggest" sub-scores (leave-day and tenure penalties) were removed.
// Scores are set by the evaluator only; see the employee's attendance record for context.

export const DEFAULT_TEMPLATE_NAME = 'النموذج العام للتقييم';

export const DEFAULT_TEMPLATE_SECTIONS: ReadonlyArray<{ title: string; weight: number; items: readonly string[] }> = [
  {
    title: 'الأداء الوظيفي',
    weight: 40,
    items: ['إنجاز المهام المطلوبة', 'جودة العمل', 'سرعة الإنجاز', 'الدقة', 'الالتزام بالمواعيد'],
  },
  {
    title: 'الانضباط والسلوك الوظيفي',
    weight: 20,
    items: ['الالتزام بالدوام', 'الالتزام بالأنظمة والتعليمات', 'حسن التعامل', 'الانضباط العام'],
  },
  {
    title: 'المهارات والكفاءات',
    weight: 20,
    items: ['التواصل', 'العمل الجماعي', 'تحمل المسؤولية', 'حل المشكلات'],
  },
  {
    title: 'المبادرة والتطوير',
    weight: 10,
    items: ['تقديم اقتراحات', 'الرغبة في التعلم', 'تحسين الأداء', 'المبادرة في العمل'],
  },
  {
    title: 'الالتزام الإداري والتقني',
    weight: 10,
    items: ['استخدام الأنظمة', 'رفع الطلبات بشكل صحيح', 'الالتزام بالإجراءات', 'دقة التحديثات والمعلومات'],
  },
];
