// Facts some document types need besides the employee record (DocumentTypeDefinition.facts).
// Loaded inside the snapshot transaction, so an approval is always checked against current facts
// (a custody item handed out after approval blocks issuance: DOC-05).
import 'server-only';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import type { Prisma } from '@prisma/client';
import { LOAN_DEDUCTIBLE_STATUSES } from '@/lib/constants';
import { findStoredFile, storedNameFromUrl } from '@/lib/storage';
import { decryptField } from '@/lib/crypto';
import { normalizeIban } from '@/lib/iban';
import type { BankFacts, EvaluationFacts, LeaveFacts, ExitFacts, InvestigationFacts, PayrollFacts, SettlementFacts, TerminationFacts } from './types';

const label = (...parts: Array<string | null | undefined>) => parts.filter((p) => p && p.trim()).join(' - ') || 'غير موصوفة';

/**
 * Open obligations of a leaver: the same custody checks as the settlement screen
 * (src/app/api/settlements/route.ts loadOpenObligations) plus loans with a remaining balance,
 * and his latest end-of-service settlement that was not rejected.
 */
export async function loadExitFacts(db: Prisma.TransactionClient, employeeId: string): Promise<ExitFacts> {
  const [assets, sims, vehicles, loans, settlement] = await Promise.all([
    db.asset.findMany({ where: { employeeId, status: 'ACTIVE' }, select: { assetType: true, description: true }, orderBy: { createdAt: 'asc' } }),
    db.telecomSim.findMany({ where: { employeeId }, select: { simNumber: true, provider: true } }),
    db.vehicle.findMany({ where: { driverId: employeeId, isArchived: false }, select: { plateNumber: true, brand: true } }),
    db.loan.findMany({
      where: { employeeId, isForgiven: false, remainingAmount: { gt: 0 }, status: { in: [...LOAN_DEDUCTIBLE_STATUSES] } },
      select: { remainingAmount: true },
    }),
    db.settlement.findFirst({
      where: { employeeId, type: 'END_OF_SERVICE', status: { not: 'REJECTED' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, lastWorkingDate: true },
    }),
  ]);
  return {
    outstanding: [
      ...assets.map((a) => ({ kind: 'ASSET' as const, label: label(a.assetType, a.description) })),
      ...sims.map((s) => ({ kind: 'SIM' as const, label: label(s.simNumber, s.provider) })),
      ...vehicles.map((v) => ({ kind: 'VEHICLE' as const, label: label(v.plateNumber, v.brand) })),
      ...loans.map((l) => ({ kind: 'LOAN' as const, label: `المتبقي ${l.remainingAmount.toFixed(2)} ر.س` })),
    ],
    settlement,
  };
}

/**
 * The settlement a statement is issued for, and the SHA-256 of its payment receipt file (printed
 * on the statement, so the document points to exactly that receipt).
 */
export async function loadSettlementFacts(db: Prisma.TransactionClient, settlementId: string | undefined): Promise<SettlementFacts> {
  if (!settlementId) return { settlement: null, receipt: { sha256: null, recorded: false } };
  const s = await db.settlement.findUnique({
    where: { id: settlementId },
    select: {
      id: true, employeeId: true, type: true, terminationReason: true, status: true, lastWorkingDate: true, yearsOfService: true,
      workingDaysSalary: true, endOfServiceAmount: true, leaveCompensation: true, overtimeAmount: true, additionalEntitlements: true,
      loansDeduction: true, additionalDeductions: true, totalSettlement: true, paymentMethod: true, paymentReference: true, paidAt: true,
      transferReceiptUrl: true,
    },
  });
  if (!s) return { settlement: null, receipt: { sha256: null, recorded: false } };
  const { transferReceiptUrl, ...settlement } = s;
  return { settlement, receipt: { sha256: await receiptSha256(transferReceiptUrl), recorded: !!storedNameFromUrl(transferReceiptUrl) } };
}

async function receiptSha256(url: string | null): Promise<string | null> {
  const name = storedNameFromUrl(url);
  if (!name) return null;
  const file = await findStoredFile(name.split('/'));
  if (!file) return null;
  return createHash('sha256').update(await readFile(file.absolutePath)).digest('hex');
}

/** The payroll row a payslip is issued for (amounts as stored). */
export async function loadPayrollFacts(db: Prisma.TransactionClient, payrollId: string | undefined): Promise<PayrollFacts> {
  if (!payrollId) return { payroll: null };
  const p = await db.payroll.findUnique({
    where: { id: payrollId },
    select: {
      id: true, employeeId: true, month: true, year: true, status: true, paidAt: true, basicSalary: true, totalAllowances: true, bonusAmount: true,
      housingAllowance: true, transportAllowance: true, otherAllowances: true,
      overtimeCost: true, gosiEmployee: true, loansDeduction: true, violationsDeduction: true, leaveDeduction: true, otherDeductions: true,
      totalDeductions: true, netSalary: true,
    },
  });
  return { payroll: p ? { ...p, status: String(p.status) } : null };
}

/** The resignation / termination request an acceptance letter answers. */
export async function loadTerminationFacts(db: Prisma.TransactionClient, requestId: string | undefined): Promise<TerminationFacts> {
  if (!requestId) return { request: null };
  const r = await db.terminationRequest.findUnique({
    where: { id: requestId },
    select: { id: true, employeeId: true, terminationType: true, status: true, createdAt: true, hrApprovedAt: true, lastWorkingDate: true },
  });
  return { request: r };
}

/** The investigation an Article 80 termination notice rests on. */
export async function loadInvestigationFacts(db: Prisma.TransactionClient, investigationId: string | undefined): Promise<InvestigationFacts> {
  if (!investigationId) return { investigation: null };
  const i = await db.investigation.findUnique({
    where: { id: investigationId },
    select: {
      id: true, employeeId: true, subject: true, status: true, updatedAt: true, createdAt: true, description: true, category: true, findings: true,
      recommendation: true, finalDecision: true, penaltyAmount: true, penaltyDays: true, investigatorName: true, investigatorRole: true,
    },
  });
  return { investigation: i };
}

/** The employee's salary account from his file (the IBAN is stored encrypted). */
export async function loadBankFacts(db: Prisma.TransactionClient, employeeId: string): Promise<BankFacts> {
  const e = await db.employee.findUnique({ where: { id: employeeId }, select: { bankName: true, ibanNumber: true } });
  let iban: string | null = null;
  try {
    iban = e?.ibanNumber ? normalizeIban(decryptField(e.ibanNumber)) : null;
  } catch {
    iban = null; // unreadable ciphertext: reported as an invalid IBAN
  }
  return { bankName: e?.bankName ?? null, iban };
}

/** The approved leave a leave letter states. */
export async function loadLeaveFacts(db: Prisma.TransactionClient, leaveId: string | undefined): Promise<LeaveFacts> {
  if (!leaveId) return { leave: null };
  const l = await db.leave.findUnique({
    where: { id: leaveId },
    select: { id: true, employeeId: true, leaveType: true, status: true, startDate: true, endDate: true, totalDays: true, isOutsideKSA: true },
  });
  return { leave: l ? { ...l, leaveType: String(l.leaveType), status: String(l.status) } : null };
}

/** A closed evaluation with its template structure (sections by order, items by order). */
export async function loadEvaluationFacts(db: Prisma.TransactionClient, evaluationId: string | undefined): Promise<EvaluationFacts> {
  if (!evaluationId) return { evaluation: null };
  const ev = await db.employeeEvaluation.findUnique({
    where: { id: evaluationId },
    select: {
      id: true, employeeId: true, status: true, totalScore: true, finalRating: true, recommendation: true, recommendationReason: true,
      strengths: true, improvements: true, finalNotes: true, employeeAcknowledgedAt: true, employeeComment: true,
      cycle: { select: { title: true, startDate: true, endDate: true } },
      itemScores: { select: { score: true, note: true, item: { select: { title: true, sortOrder: true, section: { select: { id: true, title: true, weight: true, sortOrder: true } } } } } },
    },
  });
  if (!ev) return { evaluation: null };
  const bySection = new Map<string, { title: string; weight: number; order: number; items: { title: string; score: number; note: string | null; order: number }[] }>();
  for (const s of ev.itemScores) {
    const sec = s.item.section;
    const entry = bySection.get(sec.id) ?? { title: sec.title, weight: sec.weight, order: sec.sortOrder, items: [] };
    entry.items.push({ title: s.item.title, score: s.score, note: s.note, order: s.item.sortOrder });
    bySection.set(sec.id, entry);
  }
  const sections = [...bySection.values()].sort((a, b) => a.order - b.order).map((s) => ({
    title: s.title, weight: s.weight, items: s.items.sort((a, b) => a.order - b.order).map(({ order: _o, ...i }) => i),
  }));
  const { itemScores: _scores, ...rest } = ev;
  return { evaluation: { ...rest, sections } };
}
