// /api/workforce/assumptions — company assumptions (values no authority publishes).
// GET ?companyId: definitions (ASSUMPTION_DEFS + bounds), the global rows, the company rows and the values
//     the engine resolves for that company, plus a READ-ONLY view of every company's «إعدادات الكلفة»
//     (overtime basis, medical premiums, iqama fee: edited in the company form, not here) with a one-time
//     hint when an old assumption row exists for a setting the company has not entered yet.
//     WORKFORCE roles (HR_MANAGER read-only).
// PUT { companyId ('' = all companies), items: [{ key, value, note? }] }: upsert by (key, companyId),
//     value null removes the row. SUPER_ADMIN, COMPANY_ADMIN, FINANCE_MANAGER. Audited with before/after.
//     The former keys OVERTIME_HOURLY_BASIS / MEDICAL_PREMIUM_BY_CLASS / MEDICAL_PREMIUM_DEFAULT /
//     DEPENDENT_MEDICAL_PREMIUM are refused (400, Arabic message pointing to the company settings).
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS, type AppRole } from '@/lib/constants';
import { badRequest, handleApiError, parseBody, parseQuery } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { today } from '@/lib/dates';
import { ASSUMPTION_DEFS, REMOVED_ASSUMPTION_KEYS, resolveCompanyAssumptions, type AssumptionKey } from '@/lib/workforce/assumptions';
import { companyCostSettings, MEDICAL_PREMIUM_KEYS, type CompanyCostSettings } from '@/lib/workforce/company-settings';
import { loadIqamaFeeRule } from '@/lib/workforce/load';
import { ESTIMATE_DISCLAIMER } from '@/lib/workforce/version';
import { COMPANY_WORKFORCE_ROLES } from '@/app/api/companies/_workforce';
import { assumptionsPutSchema } from '../_lib/schemas';
import { ASSUMPTION_BOUNDS, assumptionAllowsRange, assumptionFormValue, validateAssumptionValue } from '../_lib/views';
import { limitOrThrow } from '../_lib/server';

export const dynamic = 'force-dynamic';

/** Roles that may change assumptions (HR_MANAGER reads them). */
const EDIT_ROLES: readonly AppRole[] = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'FINANCE_MANAGER'];

const getSchema = z.object({ companyId: z.preprocess((v) => (v === undefined || v === null ? '' : v), z.string().trim().max(100)) });

type Row = { key: string; companyId: string; value: number | null; valueJson: string | null; note: string | null; updatedAt: Date; updatedById: string | null };

function rowsByKey(rows: Row[], companyId: string) {
  const out: Record<string, { value: unknown; note: string | null; updatedAt: string }> = {};
  for (const r of rows) {
    if (r.companyId !== companyId || !(r.key in ASSUMPTION_DEFS)) continue;
    out[r.key] = { value: assumptionFormValue(r.key as AssumptionKey, r), note: r.note, updatedAt: r.updatedAt.toISOString() };
  }
  return out;
}

/** Short text of an old assumption row (one-time hint only; the engine ignores these rows). */
function legacyText(r: Row): string {
  if (r.valueJson) {
    try {
      const j = JSON.parse(r.valueJson) as unknown;
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        return Object.entries(j as Record<string, unknown>)
          .map(([k, v]) => `${k}: ${v && typeof v === 'object' && 'base' in v ? String((v as { base: unknown }).base) : String(v)}`)
          .join('، ');
      }
      return String(j);
    } catch {
      return r.valueJson;
    }
  }
  return r.value === null ? '' : String(r.value);
}

/** Whether the company has not entered the setting an old assumption key maps to (hint shown only then). */
function settingMissing(key: string, s: CompanyCostSettings): boolean {
  if (key === 'DEPENDENT_MEDICAL_PREMIUM') return s.medicalPremiums.DEPENDENT === undefined;
  if (key === 'MEDICAL_PREMIUM_BY_CLASS' || key === 'MEDICAL_PREMIUM_DEFAULT') return Object.keys(s.medicalPremiums).every((k) => k === 'DEPENDENT');
  return false; // OVERTIME_HOURLY_BASIS always has a value (default BASIC)
}

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const { companyId } = parseQuery(req, getSchema);
    const [rows, companies, iqamaRule] = await Promise.all([
      prisma.workforceAssumption.findMany({ select: { key: true, companyId: true, value: true, valueJson: true, note: true, updatedAt: true, updatedById: true }, orderBy: [{ key: 'asc' }, { companyId: 'asc' }] }),
      prisma.company.findMany({ select: { id: true, nameArabic: true, overtimeHourlyBasis: true, medicalPremiumsJson: true, iqamaFeeYear: true }, orderBy: { nameArabic: 'asc' } }),
      loadIqamaFeeRule(today()),
    ]);
    if (companyId && !companies.some((c) => c.id === companyId)) throw badRequest('الشركة غير موجودة');
    const resolved = resolveCompanyAssumptions(rows, companyId || null, 'base');
    const overridden = new Set(rows.filter((r) => r.companyId && r.key in ASSUMPTION_DEFS).map((r) => r.companyId));
    const legacyRows = rows.filter((r) => Object.prototype.hasOwnProperty.call(REMOVED_ASSUMPTION_KEYS, r.key));
    return NextResponse.json({
      disclaimer: ESTIMATE_DISCLAIMER,
      canEdit: EDIT_ROLES.includes(user.role),
      canEditCompanySettings: COMPANY_WORKFORCE_ROLES.includes(user.role),
      companyId,
      companies: companies.map((c) => ({ id: c.id, name: c.nameArabic, hasOverrides: overridden.has(c.id) })),
      // «إعدادات الكلفة» per company: read-only here, edited in the company form (/companies/<id>/edit).
      iqamaRule,
      medicalPremiumKeys: MEDICAL_PREMIUM_KEYS,
      companySettings: companies.map((c) => {
        const s = companyCostSettings(c);
        // The company's own old row wins over the global one for the same key.
        const byKey = new Map<string, Row>();
        for (const r of legacyRows) {
          if (r.companyId !== c.id && r.companyId !== '') continue;
          if (!settingMissing(r.key, s)) continue;
          const cur = byKey.get(r.key);
          if (!cur || (cur.companyId === '' && r.companyId === c.id)) byKey.set(r.key, r);
        }
        const legacyHints = [...byKey.values()].map((r) => ({ key: r.key, label: REMOVED_ASSUMPTION_KEYS[r.key], value: legacyText(r), scope: r.companyId ? 'COMPANY' : 'GLOBAL' }));
        return { id: c.id, name: c.nameArabic, ...s, legacyHints };
      }),
      defs: Object.values(ASSUMPTION_DEFS).map((d) => ({
        key: d.key,
        kind: d.kind,
        label: d.label,
        unit: d.unit,
        defaultValue: d.defaultValue,
        options: 'options' in d ? d.options : null,
        note: 'note' in d ? d.note : null,
        allowsRange: assumptionAllowsRange(d.key),
        bounds: ASSUMPTION_BOUNDS[d.key] ?? null,
      })),
      global: rowsByKey(rows, ''),
      company: companyId ? rowsByKey(rows, companyId) : null,
      resolved: Object.fromEntries(
        Object.values(resolved)
          .filter((v): v is Exclude<typeof v, string> => typeof v === 'object' && v !== null && 'key' in v)
          .map((v) => [v.key, { value: v.value, origin: v.origin, range: v.range }]),
      ),
    });
  } catch (err) {
    return handleApiError(err, 'workforce:assumptions:GET');
  }
}

export async function PUT(req: Request) {
  try {
    const user = await requireUser(EDIT_ROLES);
    const b = await parseBody(req, assumptionsPutSchema);
    limitOrThrow(user, 'assumptions-put', 60, 10 * 60_000);
    if (b.companyId) {
      const company = await prisma.company.findUnique({ where: { id: b.companyId }, select: { id: true } });
      if (!company) throw badRequest('الشركة غير موجودة');
    }
    const checks = b.items.map((it) => ({ it, check: validateAssumptionValue(it.key, it.value) }));
    const errors = checks.filter((c) => !c.check.ok).map((c) => (c.check.ok ? '' : c.check.message));
    if (errors.length) throw badRequest(errors.join(' — '), { fields: checks.filter((c) => !c.check.ok).map((c) => c.it.key) });

    const changes = await prisma.$transaction(async (tx) => {
      const out: Array<{ key: string; before: unknown; after: unknown }> = [];
      for (const { it, check } of checks) {
        if (!check.ok) continue;
        const where = { key_companyId: { key: it.key, companyId: b.companyId } };
        const before = await tx.workforceAssumption.findUnique({ where, select: { value: true, valueJson: true, note: true } });
        if (check.store.remove) {
          if (before) await tx.workforceAssumption.delete({ where });
          if (before) out.push({ key: it.key, before, after: null });
          continue;
        }
        const data = { value: check.store.value, valueJson: check.store.valueJson, note: it.note ?? before?.note ?? null, updatedById: user.id };
        await tx.workforceAssumption.upsert({ where, create: { key: it.key, companyId: b.companyId, ...data }, update: data });
        const after = { value: data.value, valueJson: data.valueJson, note: data.note };
        if (!before || before.value !== after.value || before.valueJson !== after.valueJson || before.note !== after.note) out.push({ key: it.key, before, after });
      }
      if (out.length) {
        await logAudit(
          { userId: user.id, action: 'UPDATE', entityType: 'WorkforceAssumption', entityId: b.companyId || 'GLOBAL', details: { companyId: b.companyId || null, changes: out }, ipAddress: getClientIp(req) },
          tx,
        );
      }
      return out;
    });
    return NextResponse.json({ ok: true, changed: changes.map((c) => c.key) });
  } catch (err) {
    return handleApiError(err, 'workforce:assumptions:PUT');
  }
}
