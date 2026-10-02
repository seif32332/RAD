import { closeLinkedPaymentRequests, createPaymentRequest } from '@/modules/finance';
import { moneyActorOf } from '@/modules/platform';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, conflict, forbidden, handleApiError, notFound, parseBody } from '@/lib/http';
import { zOptDate, zOptMoney, zOptText } from '@/lib/validation';
import { addDays, dateKey } from '@/lib/dates';
import { roundMoney, sumMoney, toNumber } from '@/lib/money';
import { logAudit } from '@/lib/audit';
import {
  isNewExpiryNotInFuture,
  LEGAL_MANAGED_MESSAGE,
  LEGAL_MANAGED_RENEWALS,
  renewalPaymentTitle,
} from '@/lib/alerts';
import {
  MUQEEM_OPERATIONS_BY_DOCUMENT,
  UNRESOLVED_MUQEEM_MESSAGE,
  closeRenewalPaymentMarkers,
  findUnresolvedMuqeemTransaction,
  lockRenewalDocument,
} from '@/app/api/employees/[id]/muqeem/renewal-record';
import { ALL_COMPANIES, authz, resolveActor, scopedContext, scopedPrisma, type ScopedPrismaClient } from '@/modules/iam';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Which DB column holds the expiry date of each (entityType, documentType)
// ---------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;
type DateRow = Record<string, Date | null>;

interface EntityDateAccess {
  label: string;
  fields: Record<string, string>;
  /** Current values of every mapped date column (null row = entity not found). */
  read(tx: Tx, id: string): Promise<DateRow | null>;
  write(tx: Tx, id: string, field: string, value: Date): Promise<unknown>;
  /** Name and reference (employee number / company name) used in the payment request title. */
  describe(tx: Tx, id: string): Promise<{ name: string; reference?: string | null } | null>;
}

const personName = (first: string | null | undefined, last: string | null | undefined) => `${first ?? ''} ${last ?? ''}`.trim();

// Certified agencies and legal contracts are not in this map: their dates are managed by the
// legal department (LEGAL_MANAGED_RENEWALS) and this endpoint refuses them with 403.

const ENTITY_DATES: Record<string, EntityDateAccess> = {
  EMPLOYEE: {
    label: 'موظف',
    fields: {
      IQAMA: 'iqamaOrIdExp',
      PASSPORT: 'passportExp',
      HEALTH_CERT: 'healthCertificateExp',
      CONTRACT: 'contractEndDate',
      PROBATION: 'probationEndDate',
    },
    read: (tx, id) =>
      tx.employee.findUnique({
        where: { id },
        select: { iqamaOrIdExp: true, passportExp: true, healthCertificateExp: true, contractEndDate: true, probationEndDate: true },
      }),
    write: (tx, id, field, value) => tx.employee.update({ where: { id }, data: { [field]: value }, select: { id: true } }),
    describe: async (tx, id) => {
      const e = await tx.employee.findUnique({ where: { id }, select: { firstNameArabic: true, lastNameArabic: true, employeeId: true } });
      if (!e) return null;
      return { name: personName(e.firstNameArabic, e.lastNameArabic), reference: e.employeeId ? `الرقم الوظيفي ${e.employeeId}` : null };
    },
  },
  COMPANY: {
    label: 'شركة',
    fields: { COMMERCIAL_REG: 'commercialRegExp', TRADEMARK: 'trademarkExpDate' },
    read: (tx, id) => tx.company.findUnique({ where: { id }, select: { commercialRegExp: true, trademarkExpDate: true } }),
    write: (tx, id, field, value) => tx.company.update({ where: { id }, data: { [field]: value }, select: { id: true } }),
    describe: async (tx, id) => {
      const c = await tx.company.findUnique({ where: { id }, select: { nameArabic: true } });
      return c ? { name: c.nameArabic } : null;
    },
  },
  BRANCH: {
    label: 'فرع',
    fields: {
      MUN_LICENSE: 'munLicenseExp',
      CIVIL_DEFENSE: 'civilDefenseExp',
      RENT_CONTRACT: 'rentContractExp',
      WASTE_CONTRACT: 'wasteContractExp',
      SAFETY_CONTRACT: 'safetyContractExp',
      CAMERA_CONTRACT: 'cameraContractExp',
    },
    read: (tx, id) =>
      tx.branch.findUnique({
        where: { id },
        select: {
          munLicenseExp: true,
          civilDefenseExp: true,
          rentContractExp: true,
          wasteContractExp: true,
          safetyContractExp: true,
          cameraContractExp: true,
        },
      }),
    write: (tx, id, field, value) => tx.branch.update({ where: { id }, data: { [field]: value }, select: { id: true } }),
    describe: async (tx, id) => {
      const b = await tx.branch.findUnique({ where: { id }, select: { nameArabic: true, company: { select: { nameArabic: true } } } });
      if (!b) return null;
      const name = b.nameArabic.trim().startsWith('فرع') ? b.nameArabic : `فرع ${b.nameArabic}`;
      return { name, reference: b.company?.nameArabic ?? null };
    },
  },
  VEHICLE: {
    label: 'مركبة',
    fields: {
      VEHICLE_LICENSE: 'licenseExpDate',
      VEHICLE_INSURANCE: 'insuranceExpDate',
      VEHICLE_INSPECTION: 'inspectionExpDate',
      VEHICLE_OPERATING_CARD: 'operatingCardExpDate',
      VEHICLE_DRIVER_CARD: 'driverCardExpDate',
      VEHICLE_DRIVING_AUTH: 'drivingAuthExpDate',
    },
    read: (tx, id) =>
      tx.vehicle.findUnique({
        where: { id },
        select: {
          licenseExpDate: true,
          insuranceExpDate: true,
          inspectionExpDate: true,
          operatingCardExpDate: true,
          driverCardExpDate: true,
          drivingAuthExpDate: true,
        },
      }),
    write: (tx, id, field, value) => tx.vehicle.update({ where: { id }, data: { [field]: value }, select: { id: true } }),
    describe: async (tx, id) => {
      const v = await tx.vehicle.findUnique({
        where: { id },
        select: { brand: true, plateNumber: true, legalCompany: { select: { nameArabic: true } }, actualCompany: { select: { nameArabic: true } } },
      });
      if (!v) return null;
      return { name: `مركبة ${v.brand} ${v.plateNumber}`.trim(), reference: v.legalCompany?.nameArabic ?? v.actualCompany?.nameArabic ?? null };
    },
  },
  MEDICAL_INSURANCE: {
    label: 'تأمين طبي',
    fields: { MEDICAL_INSURANCE: 'expiryDate' },
    read: (tx, id) => tx.medicalInsurance.findUnique({ where: { id }, select: { expiryDate: true } }),
    write: (tx, id, field, value) => tx.medicalInsurance.update({ where: { id }, data: { [field]: value }, select: { id: true } }),
    describe: async (tx, id) => {
      const m = await tx.medicalInsurance.findUnique({ where: { id }, select: { insuranceIssuer: true, company: { select: { nameArabic: true } } } });
      return m ? { name: m.insuranceIssuer, reference: m.company?.nameArabic ?? null } : null;
    },
  },
};

/**
 * P1-SCOPE: true when the entity exists inside the context (scoped client). An entity type without a
 * known company key is inside an unrestricted context only (fail closed).
 */
async function entityInScope(db: ScopedPrismaClient, unrestricted: boolean, entityType: string, id: string): Promise<boolean> {
  const where = { where: { id }, select: { id: true } } as const;
  switch (entityType) {
    case 'EMPLOYEE':
      return !!(await db.employee.findUnique(where));
    case 'COMPANY':
      return !!(await db.company.findUnique(where));
    case 'BRANCH':
      return !!(await db.branch.findUnique(where));
    case 'VEHICLE':
      return !!(await db.vehicle.findUnique(where));
    case 'MEDICAL_INSURANCE':
      return !!(await db.medicalInsurance.findUnique(where));
    case 'UTILITY_METER':
      return !!(await db.utilityMeter.findUnique(where));
    default:
      return unrestricted;
  }
}

/** Document types that have no date column to update (the archive record is the renewal). */
const DATELESS_DOCUMENT_TYPES = new Set(['ANNUAL_LEAVE_DUE', 'UTILITY_METER']);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Exact timestamp (the client echoes the stored expirationDate back); ''/null -> null. */
const zOptTimestamp = z
  .preprocess((v) => (v === '' || v === null || v === undefined ? null : v), z.coerce.date({ invalid_type_error: 'تاريخ غير صالح' }).nullable())
  .optional();

const optStr = (max = 200) => z.preprocess((v) => (v === null || v === undefined ? '' : String(v)), z.string().trim().max(max)).optional();

const paymentEntrySchema = z.object({
  type: z.string().trim().max(20).optional(),
  biller: optStr(),
  sadadNumber: optStr(),
  bankName: optStr(),
  iban: optStr(64),
  amount: z.union([z.string(), z.number()]).optional(),
  details: optStr(1000),
});

const bodySchema = z
  .object({
    action: z.enum(['RENEWED', 'TERMINATED']),
    entityType: z.string().trim().min(1).max(50),
    entityId: z.string().trim().min(1).max(100),
    documentType: z.string().trim().min(1).max(50),
    oldExpDate: zOptTimestamp,
    newExpDate: zOptDate,
    attachmentUrl: zOptText(2000),
    notes: zOptText(2000),
    requiresPayment: z.preprocess((v) => v === true || v === 'true', z.boolean()).optional(),
    /** Explicit confirmation that a new expiry date of today or earlier is intended. */
    confirmPastDate: z.preprocess((v) => v === true || v === 'true', z.boolean()).optional(),
    paymentAmount: zOptMoney,
    paymentEntries: z.array(paymentEntrySchema).max(50).nullish(),
  })
  .superRefine((b, ctx) => {
    if (b.action === 'RENEWED' && !b.newExpDate && !b.requiresPayment) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['newExpDate'], message: 'تاريخ التجديد الجديد مطلوب' });
    }
  });

type RenewalBody = z.infer<typeof bodySchema>;

function describePaymentEntries(entries: RenewalBody['paymentEntries']): string {
  if (!entries?.length) return '';
  return entries
    .map((p) => {
      const amount = roundMoney(toNumber(p.amount));
      if (p.type === 'SADAD') return `مفوتر: ${p.biller || 'بدون'} | سداد: ${p.sadadNumber || 'بدون'} | مبلغ: ${amount} ر.س`;
      return `بنك: ${p.bankName || 'بدون'} | آيبان: ${p.iban || 'بدون'} | مبلغ: ${amount} ر.س`;
    })
    .join(' --- ');
}

/** [start, end) of the calendar day of a stored date (for matching archive rows by day). */
function dayRange(d: Date): { gte: Date; lt: Date } {
  const start = new Date(`${dateKey(d)}T00:00:00.000Z`);
  return { gte: start, lt: addDays(start, 1) };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Record a renewal decision for a document in the renewals queue:
 *  - TERMINATED: dismiss the alert for this expiry date (archive only).
 *  - RENEWED + requiresPayment: archive as PENDING_PAYMENT and open a payment request for the owner.
 *  - RENEWED without payment: set the new expiry date on the entity and close paid requests.
 * Concurrent/double submissions for the same document are serialized with a transaction-level
 * advisory lock and rejected with 409 when the renewal was already applied.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.GOV);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'gov.renewal.decide');
    const body = await parseBody(req, bodySchema);
    const { action, entityType, entityId, documentType } = body;
    const requiresPayment = action === 'RENEWED' && !!body.requiresPayment;
    const oldExpDate = body.oldExpDate ?? null;
    const newExpDate = body.newExpDate ?? null;

    // Agencies and legal contracts are renewed by the legal department only (read-only here).
    const isLegalManaged = (key: string) => Object.prototype.hasOwnProperty.call(LEGAL_MANAGED_RENEWALS, key);
    if (isLegalManaged(entityType) || isLegalManaged(documentType)) {
      throw forbidden(`${LEGAL_MANAGED_MESSAGE}، ولا يمكن تجديده أو إنهاؤه من طابور التجديدات`);
    }

    // The document's entity must belong to the user's companies (404 otherwise, before any write).
    if (!(await entityInScope(scopedPrisma(ctx), ctx.companies === ALL_COMPANIES, entityType, entityId))) throw notFound();

    if (action === 'RENEWED' && newExpDate && !body.confirmPastDate && isNewExpiryNotInFuture(newExpDate)) {
      throw badRequest('تاريخ الانتهاء الجديد اليوم أو قبله، فتبقى الوثيقة منتهية. صحّح التاريخ أو أكّد أنه مقصود', {
        field: 'newExpDate',
        code: 'PAST_DATE_REQUIRES_CONFIRMATION',
      });
    }

    const access = Object.prototype.hasOwnProperty.call(ENTITY_DATES, entityType) ? ENTITY_DATES[entityType] : undefined;
    const fieldName = access && Object.prototype.hasOwnProperty.call(access.fields, documentType) ? access.fields[documentType] : undefined;
    if (action === 'RENEWED' && !fieldName && !DATELESS_DOCUMENT_TYPES.has(documentType)) {
      throw badRequest('نوع الوثيقة غير صالح للتحديث');
    }

    const archiveAction = requiresPayment ? 'PENDING_PAYMENT' : action;

    const result = await prisma.$transaction(async (tx) => {
      // Serialize all actions on the same document (released automatically at commit/rollback).
      await lockRenewalDocument(tx, entityId, documentType);

      // ---- A Muqeem renewal of this document with an unknown outcome must be reconciled first:
      // it may have been executed, and changing the date here would allow a second Muqeem call.
      const muqeemOps = Object.prototype.hasOwnProperty.call(MUQEEM_OPERATIONS_BY_DOCUMENT, documentType)
        ? MUQEEM_OPERATIONS_BY_DOCUMENT[documentType]
        : null;
      if (action === 'RENEWED' && entityType === 'EMPLOYEE' && muqeemOps) {
        const unresolved = await findUnresolvedMuqeemTransaction(tx, entityId, muqeemOps);
        if (unresolved) {
          throw conflict(UNRESOLVED_MUQEEM_MESSAGE, {
            code: 'MUQEEM_UNRESOLVED',
            muqeemTransactionId: unresolved.id,
            operation: unresolved.operation,
            status: unresolved.status,
          });
        }
      }

      // ---- Guards against double submission ----
      if (requiresPayment) {
        const open = await tx.paymentRequest.count({
          where: { entityId, documentType, status: { in: ['PENDING_OWNER', 'PENDING_FINANCE'] } },
        });
        if (open > 0) throw conflict('يوجد طلب سداد قائم لهذه الوثيقة بانتظار الاعتماد أو السداد');
      } else if (action === 'RENEWED' && fieldName && access && newExpDate) {
        const row = await access.read(tx, entityId);
        if (!row) throw notFound();
        const current = row[fieldName] ?? null;
        if (oldExpDate && dateKey(current) !== dateKey(oldExpDate)) {
          throw conflict('تم تحديث تاريخ هذه الوثيقة مسبقاً، يرجى تحديث الصفحة');
        }
      } else if (oldExpDate) {
        // TERMINATED, or RENEWED of a dateless document: one decision per expiry date.
        const dup = await tx.renewalArchive.count({
          where: { entityId, documentType, action: archiveAction, oldExpDate: dayRange(oldExpDate) },
        });
        if (dup > 0) throw conflict('تم تنفيذ هذا الإجراء على الوثيقة مسبقاً');
      }

      // 1. Archive record (PENDING_PAYMENT keeps the item in the renewals queue until paid)
      const archive = await tx.renewalArchive.create({
        data: {
          entityType,
          entityId,
          documentType,
          action: archiveAction,
          oldExpDate,
          newExpDate,
          attachmentUrl: body.attachmentUrl ?? null,
          notes: body.notes ?? null,
        },
        select: { id: true },
      });

      let paymentRequestId: string | null = null;

      if (action === 'RENEWED') {
        // 2. Update the entity's expiry date (not when deferred to finance)
        if (!requiresPayment && newExpDate && fieldName && access) {
          await access.write(tx, entityId, fieldName, newExpDate);
        }

        if (requiresPayment) {
          // 3. Close stale RETURNED requests, then open a new payment request for the owner
          await closeLinkedPaymentRequests(tx, {
            entityId,
            documentType,
            from: ['RETURNED'],
            to: 'COMPLETED',
            returnReason: 'تم إعادة التجديد برقم سداد جديد',
            operationKey: `renewal:${archive.id}:refile`,
          });
          const amount = roundMoney(
            body.paymentAmount ?? sumMoney((body.paymentEntries ?? []).map((p) => toNumber(p.amount))),
          );
          const accountDetails = describePaymentEntries(body.paymentEntries);
          const described = access ? await access.describe(tx, entityId) : null;
          // finance.createPaymentRequest (money.gateway): the owner approves it, finance pays it. An
          // employee's own document fees go to that employee (BR-PAY-001 beneficiary, Q-PAY-E).
          const payment = await createPaymentRequest(tx, {
            actor: moneyActorOf(user),
            title: renewalPaymentTitle(documentType, described ?? (access ? { name: access.label } : null)),
            reason: body.notes || 'رسوم تجديد مجدولة عبر النظام',
            amount,
            accountNumber: accountDetails || null,
            receiptUrl: body.attachmentUrl ?? null,
            status: 'PENDING_OWNER',
            entityId,
            entityType,
            documentType,
            beneficiaryEmployeeId: entityType === 'EMPLOYEE' ? entityId : null,
            operationKey: `renewal:${archive.id}:payment`,
          });
          paymentRequestId = payment.id;
        } else {
          // Renewal confirmed: close PAID requests and drop PENDING_PAYMENT markers
          // (shared with the Muqeem renewal, src/app/api/employees/[id]/muqeem).
          await closeRenewalPaymentMarkers(tx, entityId, documentType);
        }
      }

      return { archiveId: archive.id, paymentRequestId };
    });

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'RenewalArchive',
      entityId: result.archiveId,
      details: {
        renewalAction: archiveAction,
        entityType,
        entityId,
        documentType,
        oldExpDate: dateKey(oldExpDate),
        newExpDate: dateKey(newExpDate),
        paymentRequestId: result.paymentRequestId,
      },
      ipAddress: getClientIp(req),
    });

    return NextResponse.json({ success: true, ...result }, { status: 200 });
  } catch (err) {
    return handleApiError(err, 'renewals/action:POST');
  }
}
