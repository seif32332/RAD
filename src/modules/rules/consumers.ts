// Consumers of rules events (DOMAIN_BOUNDARIES §5.5; LIFECYCLE_MODEL §2.2: side effects run after the
// transition commits, at most once per event).
//
// DEC-PO-126: an override outside the legal bound accepted with an acknowledgement is reported to the
// business owner over the DEC-PO-022 channel. That channel is the owner's contact recorded by Radeef
// (not editable in-tenant): OWNER_ALERT_EMAIL in the tenant's environment, set by Radeef ops. The
// email is queued in NotificationOutbox (outbox-dispatch sends it); its body holds the rule, the two
// values and a login link, never a company name, a person or an id (the digest rule of DEC-PO-040).
//
// Client-safe module graph: type imports only at the top; platform is loaded when the consumer runs.
import type { DomainEventRecord, EventConsumer } from '@/modules/platform';
import { RULE_CATALOGUE } from './catalogue';
import { RULES_OVERRIDE_BELOW_LEGAL_EVENT } from './events';

export const BELOW_LEGAL_OWNER_ALERT_CONSUMER = 'rules.belowLegalOwnerAlert';

type Env = Record<string, string | undefined>;

/** The owner's contact of DEC-PO-022 (set by Radeef ops), or null when it is not configured. */
export function ownerAlertRecipient(env: Env = process.env): string | null {
  const v = String(env.OWNER_ALERT_EMAIL ?? '').trim();
  return /^[^\s@"'<>]{1,64}@[^\s@"'<>]{1,253}\.[a-z]{2,63}$/i.test(v) ? v : null;
}

function loginLink(env: Env): string | null {
  const base = String(env.APP_URL || env.NEXTAUTH_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s"'<>]+$/.test(base) ? `${base}/login` : null;
}

/** The owner alert of one `rules.override.belowLegal` event (pure). */
export function belowLegalOwnerAlert(event: Pick<DomainEventRecord, 'payload'>, env: Env = process.env): { subject: string; body: string } | null {
  const p = (event.payload ?? {}) as { key?: unknown; value?: unknown; legalValue?: unknown; bound?: unknown; effectiveFrom?: unknown };
  if (typeof p.key !== 'string' || typeof p.value !== 'number' || typeof p.legalValue !== 'number') return null;
  const def = RULE_CATALOGUE.find((d) => d.key === p.key);
  const label = def?.label ?? p.key;
  const direction = p.bound === 'MAX' ? 'أعلى من الحد النظامي الأعلى' : 'أقل من الحد النظامي الأدنى';
  const login = loginLink(env);
  const lines = [
    'تنبيه للمالك — نظام رديف',
    '',
    `اعتُمدت في إحدى شركاتك قيمة ${direction} بإقرار صريح:`,
    `- القاعدة: ${label}`,
    `- القيمة المعتمدة: ${p.value}`,
    `- القيمة النظامية: ${p.legalValue}`,
    typeof p.effectiveFrom === 'string' ? `- نافذة من: ${p.effectiveFrom}` : '',
    '',
    'تظهر هذه القيمة كتحذير أينما استُخدمت، وتُسجَّل كاختلاف مشروح في لوحة السلامة.',
    'السبب ومن اعتمدها متاحان داخل النظام فقط بعد تسجيل الدخول.',
    login ? `تسجيل الدخول: ${login}` : 'سجّل الدخول إلى النظام للاطلاع على التفاصيل.',
  ].filter((l, i, all) => l !== '' || all[i - 1] !== '');
  return { subject: `رديف: قيمة ${direction} (${label})`, body: lines.join('\n') };
}

export const belowLegalOwnerAlertConsumer: EventConsumer = {
  name: BELOW_LEGAL_OWNER_ALERT_CONSUMER,
  eventTypes: [RULES_OVERRIDE_BELOW_LEGAL_EVENT],
  async handle(event, ctx) {
    const to = ownerAlertRecipient();
    if (!to) return { outcome: 'NO_OWNER_CONTACT' };
    const msg = belowLegalOwnerAlert(event);
    if (!msg) return { outcome: 'NOT_APPLICABLE' };
    const { enqueueEmails } = await import('@/modules/platform');
    const added = await enqueueEmails(ctx.tx, [{ idempotencyKey: `${BELOW_LEGAL_OWNER_ALERT_CONSUMER}:${event.idempotencyKey}`, recipient: to, ...msg }]);
    return { outcome: added ? 'QUEUED' : 'ALREADY_QUEUED' };
  },
};

export const RULES_CONSUMERS: readonly EventConsumer[] = Object.freeze([belowLegalOwnerAlertConsumer]);
