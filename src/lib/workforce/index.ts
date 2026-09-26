// Workforce decision engine ("محرك القرارات"), phases 1–2 — PURE public API (client-safe).
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
