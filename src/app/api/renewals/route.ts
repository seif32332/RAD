import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS, SETTLEMENT_STATUS } from '@/lib/constants';
import { handleApiError, parseQuery } from '@/lib/http';
import {
  classifyExpiry,
  EMPLOYEE_DUE_DOCUMENT_TYPES,
  getAlertThresholds,
  type ExpiryLevel,
  LEGAL_MANAGED_MESSAGE,
  LEGAL_MANAGED_RENEWALS,
  nextAnnualLeaveDueDate,
  RENEWAL_DOCUMENT_LABELS as DOC,
  renewalDateKey,
  renewalKey,
} from '@/lib/alerts';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  early: z.string().max(10).optional(),
  employeeId: z.string().trim().max(100).optional(),
});

/** EMPLOYEE_DUES = the employee's entitlements (annual leave due, end of probation), not documents. */
type RenewalCategory = 'HR' | 'EMPLOYEE_DUES' | 'ADMIN' | 'LOGISTICS' | 'LEGAL_DOCS';

interface RenewalItem {
  id: string;
  entityId: string;
  entityType: string;
  entityName: string;
  iqamaNumber?: string;
  documentType: string;
  documentName: string;
  expirationDate: Date;
  /** Whole days until expiry relative to today in Riyadh (0 = expires today, < 0 = expired). */
  daysLeft: number;
  /** Same classification as the alert screens (ok = outside the alert window, e.g. early renewal). */
  level: ExpiryLevel;
  category: RenewalCategory;
  isEarlyRenewal?: boolean;
  /** Dates owned by the legal department: shown here for visibility, renewed only from manageUrl. */
  readOnly?: boolean;
  readOnlyReason?: string;
  manageUrl?: string;
}

interface PaymentFlags {
  pending: boolean;
  paid: boolean;
  returned: { returnReason: string | null } | null;
}

/**
 * Renewal queue: every document inside its alert window (or already expired), plus any
 * document that has a renewal in progress (payment request / pending-payment archive).
 * `?early=true` lists every document regardless of the window (early renewal mode).
 */
export async function GET(req: Request) {
  try {
    await requireUser(ROLE_GROUPS.GOV);
    const query = parseQuery(req, querySchema);
    const early = query.early === 'true';
    const employeeId = query.employeeId || undefined;
    const now = new Date();

    const [
      t,
      terminatedArchives,
      employees,
      earlyRenewalSettlements,
      leavePostponements,
      payments,
      pendingPaymentArchives,
      companies,
      branches,
      vehicles,
      contracts,
      medicalInsurances,
      agencies,
    ] = await Promise.all([
      getAlertThresholds(prisma),
      prisma.renewalArchive.findMany({
        where: { action: 'TERMINATED' },
        select: { entityId: true, documentType: true, oldExpDate: true },
      }),
      prisma.employee.findMany({
        where: { isTerminated: false, ...(employeeId ? { id: employeeId } : {}) },
        select: {
          id: true,
          firstNameArabic: true,
          lastNameArabic: true,
          iqamaOrIdNumber: true,
          iqamaOrIdExp: true,
          passportExp: true,
          healthCertificateExp: true,
          probationEndDate: true,
          contractEndDate: true,
          leaveAccrualStartDate: true,
        },
      }),
      // Settlements flagged "[NEEDS_EARLY_RENEWAL]" force the iqama into the queue.
      prisma.settlement.findMany({
        where: {
          status: { in: [SETTLEMENT_STATUS.PENDING_APPROVAL, SETTLEMENT_STATUS.OWNER_APPROVED, SETTLEMENT_STATUS.PAID] },
          additionalNotes: { contains: '[NEEDS_EARLY_RENEWAL]' },
          ...(employeeId ? { employeeId } : {}),
        },
        select: { employeeId: true, createdAt: true },
      }),
      prisma.renewalArchive.findMany({
        where: { documentType: 'ANNUAL_LEAVE_DUE', action: 'RENEWED', ...(employeeId ? { entityId: employeeId } : {}) },
        select: { entityId: true, newExpDate: true, createdAt: true },
      }),
      prisma.paymentRequest.findMany({
        where: { status: { in: ['PENDING_OWNER', 'PENDING_FINANCE', 'RETURNED', 'PAID'] }, entityId: { not: null } },
        select: { entityId: true, documentType: true, status: true, returnReason: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.renewalArchive.findMany({
        where: { action: 'PENDING_PAYMENT' },
        select: { entityId: true, documentType: true },
      }),
      employeeId
        ? Promise.resolve([])
        : prisma.company.findMany({ select: { id: true, nameArabic: true, commercialRegExp: true, trademarkExpDate: true } }),
      employeeId
        ? Promise.resolve([])
        : prisma.branch.findMany({
            select: {
              id: true,
              nameArabic: true,
              company: { select: { nameArabic: true } },
              munLicenseExp: true,
              civilDefenseExp: true,
              rentContractExp: true,
              wasteContractExp: true,
              safetyContractExp: true,
              cameraContractExp: true,
            },
          }),
      employeeId
        ? Promise.resolve([])
        : prisma.vehicle.findMany({
            where: { isArchived: false },
            select: {
              id: true,
              brand: true,
              plateNumber: true,
              licenseExpDate: true,
              insuranceExpDate: true,
              inspectionExpDate: true,
              operatingCardExpDate: true,
              driverCardExpDate: true,
              drivingAuthExpDate: true,
            },
          }),
      employeeId
        ? Promise.resolve([])
        : prisma.legalContract.findMany({ where: { status: 'ACTIVE' }, select: { id: true, title: true, endDate: true } }),
      employeeId
        ? Promise.resolve([])
        : prisma.medicalInsurance.findMany({
            select: { id: true, insuranceIssuer: true, expiryDate: true, company: { select: { nameArabic: true } } },
          }),
      employeeId
        ? Promise.resolve([])
        : prisma.certifiedAgency.findMany({
            where: { status: 'ACTIVE' },
            select: { id: true, agencyNumber: true, agentName: true, endDate: true },
          }),
    ]);

    // ---- Indexes (O(1) lookups instead of scanning arrays per document) ----
    const terminatedKeys = new Set(terminatedArchives.map((a) => renewalDateKey(a.entityId, a.documentType, a.oldExpDate)));
    const pendingArchiveKeys = new Set(pendingPaymentArchives.map((a) => renewalKey(a.entityId, a.documentType)));

    const paymentFlags = new Map<string, PaymentFlags>();
    for (const p of payments) {
      if (!p.entityId || !p.documentType) continue;
      const key = renewalKey(p.entityId, p.documentType);
      const flags = paymentFlags.get(key) ?? { pending: false, paid: false, returned: null };
      if (p.status === 'PENDING_OWNER' || p.status === 'PENDING_FINANCE') flags.pending = true;
      else if (p.status === 'PAID') flags.paid = true;
      // payments are newest-first, so the first RETURNED row is the latest one
      else if (p.status === 'RETURNED' && !flags.returned) flags.returned = { returnReason: p.returnReason };
      paymentFlags.set(key, flags);
    }

    const earlyRenewalEmployeeIds = new Set<string>();
    if (earlyRenewalSettlements.length > 0) {
      const ids = [...new Set(earlyRenewalSettlements.map((s) => s.employeeId))];
      const renewed = await prisma.renewalArchive.groupBy({
        by: ['entityId'],
        where: { documentType: 'IQAMA', action: 'RENEWED', entityId: { in: ids } },
        _max: { createdAt: true },
      });
      const lastRenewedAt = new Map(renewed.map((r) => [r.entityId, r._max.createdAt]));
      for (const s of earlyRenewalSettlements) {
        const last = lastRenewedAt.get(s.employeeId);
        // Still needed unless the iqama was renewed after the settlement was created
        if (!last || last <= s.createdAt) earlyRenewalEmployeeIds.add(s.employeeId);
      }
    }

    const latestPostponement = new Map<string, { newExpDate: Date | null; createdAt: Date }>();
    for (const p of leavePostponements) {
      const cur = latestPostponement.get(p.entityId);
      if (!cur || p.createdAt > cur.createdAt) latestPostponement.set(p.entityId, p);
    }

    const hasAnyPending = (entityId: string, docType: string) => {
      const key = renewalKey(entityId, docType);
      const f = paymentFlags.get(key);
      return (!!f && (f.pending || f.paid || !!f.returned)) || pendingArchiveKeys.has(key);
    };
    const isTerminated = (entityId: string, docType: string, dates: Array<Date | null>) =>
      dates.some((d) => !!d && terminatedKeys.has(renewalDateKey(entityId, docType, d)));
    const inWindow = (date: Date | null, thresholdDays: number) => {
      if (!date) return false;
      if (early) return true;
      const s = classifyExpiry(date, thresholdDays, now);
      return !!s && s.level !== 'ok';
    };

    const results: RenewalItem[] = [];
    const add = (
      entity: { id: string; type: string; name: string; category: RenewalCategory; iqamaNumber?: string },
      documentType: string,
      documentName: string,
      date: Date | null,
      thresholdDays: number,
      opts: { force?: boolean; terminationDates?: Array<Date | null>; extra?: Partial<RenewalItem> } = {},
    ) => {
      if (!date) return;
      const status = classifyExpiry(date, thresholdDays, now);
      if (!status) return;
      const due = inWindow(date, thresholdDays) || !!opts.force || hasAnyPending(entity.id, documentType);
      if (!due) return;
      if (isTerminated(entity.id, documentType, [date, ...(opts.terminationDates ?? [])])) return;
      results.push({
        id: randomUUID(),
        entityId: entity.id,
        entityType: entity.type,
        entityName: entity.name,
        ...(entity.iqamaNumber !== undefined ? { iqamaNumber: entity.iqamaNumber } : {}),
        documentType,
        documentName,
        expirationDate: date,
        daysLeft: status.daysLeft,
        level: status.level,
        category: EMPLOYEE_DUE_DOCUMENT_TYPES.has(documentType) ? 'EMPLOYEE_DUES' : entity.category,
        ...opts.extra,
      });
    };

    // 1. Employees
    for (const emp of employees) {
      const e = {
        id: emp.id,
        type: 'EMPLOYEE',
        name: `${emp.firstNameArabic ?? ''} ${emp.lastNameArabic ?? ''}`.trim(),
        category: 'HR' as const,
        iqamaNumber: emp.iqamaOrIdNumber,
      };
      const needsEarlyRenewal = earlyRenewalEmployeeIds.has(emp.id);
      const iqamaInThreshold = inWindow(emp.iqamaOrIdExp, t.iqama);
      add(e, 'IQAMA', DOC.IQAMA, emp.iqamaOrIdExp, t.iqama, {
        force: needsEarlyRenewal,
        extra: { isEarlyRenewal: needsEarlyRenewal && !iqamaInThreshold },
      });
      add(e, 'PASSPORT', DOC.PASSPORT, emp.passportExp, t.passport);
      add(e, 'HEALTH_CERT', DOC.HEALTH_CERT, emp.healthCertificateExp, t.healthCert);
      add(e, 'PROBATION', DOC.PROBATION, emp.probationEndDate, t.probation);
      add(e, 'CONTRACT', DOC.CONTRACT, emp.contractEndDate, t.contract);

      if (emp.leaveAccrualStartDate) {
        const postponed = latestPostponement.get(emp.id)?.newExpDate ?? null;
        const nextDue = nextAnnualLeaveDueDate(emp.leaveAccrualStartDate, postponed);
        // A dismissal (TERMINATED) is recorded against the due date the page showed; older
        // records were matched on the cycle's accrual start, so both identify a dismissed cycle.
        add(e, 'ANNUAL_LEAVE_DUE', DOC.ANNUAL_LEAVE_DUE, nextDue, t.annualLeave, {
          terminationDates: [emp.leaveAccrualStartDate],
        });
      }
    }

    // 2. Companies
    for (const c of companies) {
      const e = { id: c.id, type: 'COMPANY', name: c.nameArabic, category: 'ADMIN' as const };
      // commercialRegExp holds the annual confirmation date (the register itself no longer expires).
      add(e, 'COMMERCIAL_REG', DOC.COMMERCIAL_REG, c.commercialRegExp, t.commercialReg);
      add(e, 'TRADEMARK', DOC.TRADEMARK, c.trademarkExpDate, t.trademark);
    }

    // 3. Branches
    for (const b of branches) {
      const e = { id: b.id, type: 'BRANCH', name: `${b.nameArabic} (${b.company?.nameArabic ?? ''})`, category: 'ADMIN' as const };
      add(e, 'MUN_LICENSE', DOC.MUN_LICENSE, b.munLicenseExp, t.municipalLicense);
      add(e, 'CIVIL_DEFENSE', DOC.CIVIL_DEFENSE, b.civilDefenseExp, t.civilDefense);
      add(e, 'RENT_CONTRACT', DOC.RENT_CONTRACT, b.rentContractExp, t.leaseContract);
      add(e, 'WASTE_CONTRACT', DOC.WASTE_CONTRACT, b.wasteContractExp, t.wasteContract);
      add(e, 'SAFETY_CONTRACT', DOC.SAFETY_CONTRACT, b.safetyContractExp, t.safetyContract);
      add(e, 'CAMERA_CONTRACT', DOC.CAMERA_CONTRACT, b.cameraContractExp, t.cameraContract);
    }

    // 4. Vehicles
    for (const v of vehicles) {
      const e = { id: v.id, type: 'VEHICLE', name: `مركبة ${v.brand} - ${v.plateNumber}`, category: 'LOGISTICS' as const };
      add(e, 'VEHICLE_LICENSE', DOC.VEHICLE_LICENSE, v.licenseExpDate, t.vehicleLicense);
      add(e, 'VEHICLE_INSURANCE', DOC.VEHICLE_INSURANCE, v.insuranceExpDate, t.vehicleInsurance);
      add(e, 'VEHICLE_INSPECTION', DOC.VEHICLE_INSPECTION, v.inspectionExpDate, t.vehicleInspection);
      add(e, 'VEHICLE_OPERATING_CARD', DOC.VEHICLE_OPERATING_CARD, v.operatingCardExpDate, t.operatingCard);
      add(e, 'VEHICLE_DRIVER_CARD', DOC.VEHICLE_DRIVER_CARD, v.driverCardExpDate, t.driverCard);
      add(e, 'VEHICLE_DRIVING_AUTH', DOC.VEHICLE_DRIVING_AUTH, v.drivingAuthExpDate, t.drivingAuth);
    }

    // 5. Legal contracts and 6. certified agencies: read-only here (renewed by the legal
    // department; /api/renewals/action refuses them with 403).
    const legalReadOnly = (type: keyof typeof LEGAL_MANAGED_RENEWALS) => ({
      extra: { readOnly: true, readOnlyReason: LEGAL_MANAGED_MESSAGE, manageUrl: LEGAL_MANAGED_RENEWALS[type].manageUrl },
    });
    for (const c of contracts) {
      add({ id: c.id, type: 'LEGAL_CONTRACT', name: c.title, category: 'LEGAL_DOCS' }, 'LEGAL_CONTRACT', DOC.LEGAL_CONTRACT, c.endDate, t.legalContract, legalReadOnly('LEGAL_CONTRACT'));
    }
    for (const a of agencies) {
      const name = `وكالة ${a.agencyNumber} - ${a.agentName}`;
      add({ id: a.id, type: 'AGENCY', name, category: 'LEGAL_DOCS' }, 'AGENCY', DOC.AGENCY, a.endDate, t.agency, legalReadOnly('AGENCY'));
    }

    // 7. Medical insurance policies
    for (const m of medicalInsurances) {
      const name = `${m.insuranceIssuer} (${m.company?.nameArabic ?? ''})`;
      add({ id: m.id, type: 'MEDICAL_INSURANCE', name, category: 'HR' }, 'MEDICAL_INSURANCE', DOC.MEDICAL_INSURANCE, m.expiryDate, t.medicalInsurance);
    }

    const mapped = results.map((r) => {
      const key = renewalKey(r.entityId, r.documentType);
      const f = paymentFlags.get(key);
      return {
        ...r,
        isPendingPayment: !!f?.pending,
        isReturnedFromFinance: !!f?.returned,
        returnReason: f?.returned?.returnReason ?? null,
        isPaidAwaitingConfirmation: !!f?.paid,
        isReferredForRenewal: pendingArchiveKeys.has(key),
      };
    });

    // Nearest expiry first
    mapped.sort((a, b) => a.expirationDate.getTime() - b.expirationDate.getTime());

    return NextResponse.json(mapped);
  } catch (err) {
    return handleApiError(err, 'renewals:GET');
  }
}
