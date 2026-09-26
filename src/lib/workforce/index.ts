// Workforce decision engine ("محرك القرارات"), phases 1–4 — PURE public API (client-safe).
// The database loader is src/lib/workforce/load.ts (server-only) and is NOT re-exported here.
export * from '@/lib/workforce/types';
export * from '@/lib/workforce/version';
export * from '@/lib/workforce/rules';
export * from '@/lib/workforce/assumptions';
export * from '@/lib/workforce/company-settings';
export * from '@/lib/workforce/formulas';
export * from '@/lib/workforce/true-cost';
export * from '@/lib/workforce/exit-cost';
export * from '@/lib/workforce/overview';
export * from '@/lib/workforce/snapshot';
export * from '@/lib/workforce/reasons';
export * from '@/lib/workforce/privacy';
export * from '@/lib/workforce/nitaqat';
export * from '@/lib/workforce/saudization';
export * from '@/lib/workforce/hiring';
export * from '@/lib/workforce/planning';
export * from '@/lib/workforce/sensitivity';
// Phase 4 Excel builders (exceljs) are server-side: only their types are re-exported here.
export type * from '@/lib/workforce/export-xlsx';
// Phase 4 PDF reports (radeef-render, server-only): only their types are re-exported here.
export type * from '@/lib/workforce/report-pdf';
