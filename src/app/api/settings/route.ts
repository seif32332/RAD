import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, handleApiError, parseBody } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { DEFAULT_SETTINGS, isKnownSetting, normalizeSettingValue, settingValueProblem } from './definitions';

export const dynamic = 'force-dynamic';

const SETTING_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/;
const MAX_KEYS = 300;

const zSettingValue = z
  .union([z.string(), z.number().finite(), z.boolean(), z.null()])
  .transform((v) => (v === null ? '' : String(v)))
  .pipe(z.string().max(5000, 'قيمة الإعداد طويلة جداً'));

const SettingsSchema = z.object({
  settings: z
    .record(z.string().regex(SETTING_KEY, 'مفتاح إعداد غير صالح'), zSettingValue)
    .refine((obj) => Object.keys(obj).length <= MAX_KEYS, 'عدد الإعدادات كبير جداً'),
});

/** GET: every editable setting (defaults <- stored values). Admins only. */
export async function GET() {
  try {
    await requireUser(ROLE_GROUPS.ADMIN);
    const keys = Object.keys(DEFAULT_SETTINGS);
    const dbSettings = await prisma.systemSetting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });

    const merged: Record<string, string> = { ...DEFAULT_SETTINGS };
    for (const s of dbSettings) merged[s.key] = s.value;

    return NextResponse.json({ settings: merged });
  } catch (err) {
    return handleApiError(err, 'settings:GET');
  }
}

async function saveSettings(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ADMIN);
    const { settings } = await parseBody(req, SettingsSchema);

    // Keys nothing reads are ignored (never stored), known keys are validated.
    const ignored: string[] = [];
    const problems: Record<string, string> = {};
    const entries: Array<[string, string]> = [];
    for (const [key, raw] of Object.entries(settings)) {
      if (!isKnownSetting(key)) {
        ignored.push(key);
        continue;
      }
      const value = normalizeSettingValue(raw);
      const problem = settingValueProblem(key, value);
      if (problem) problems[key] = problem;
      else entries.push([key, value]);
    }
    const invalidKeys = Object.keys(problems);
    if (invalidKeys.length > 0) {
      const list = invalidKeys.map((k) => `${k} (${problems[k]})`).join('، ');
      throw badRequest(`قيم غير صالحة في الإعدادات: ${list}`, { fields: problems });
    }

    const existing = await prisma.systemSetting.findMany({
      where: { key: { in: entries.map(([k]) => k) } },
      select: { key: true, value: true },
    });
    const current = new Map(existing.map((s) => [s.key, s.value]));
    const changed = entries.filter(([k, v]) => current.get(k) !== v && !(current.get(k) === undefined && DEFAULT_SETTINGS[k] === v));

    if (changed.length > 0) {
      await prisma.$transaction(
        changed.map(([key, value]) =>
          prisma.systemSetting.upsert({ where: { key }, update: { value }, create: { key, value } }),
        ),
      );
      await logAudit({
        userId: user.id,
        action: 'UPDATE',
        entityType: 'SystemSetting',
        details: Object.fromEntries(changed.map(([k, v]) => [k, { from: current.get(k) ?? DEFAULT_SETTINGS[k] ?? null, to: v }])),
        ipAddress: getClientIp(req),
      });
    }

    return NextResponse.json({ message: 'تم حفظ جميع الإعدادات بنجاح ✅', updated: changed.length, ignored });
  } catch (err) {
    return handleApiError(err, 'settings:SAVE');
  }
}

/** The settings page saves with POST { settings: { key: value } }. */
export const POST = saveSettings;
export const PUT = saveSettings;
