// iam's side effects (LIFECYCLE_MODEL §2.2, ARCH-017: after the transition commits, from its event):
//
//   iam.credentialLinkMail   on iam.credentialLink.issued: queues the one-time link email to the address the
//                            link was issued for (the attested email of a reset, DEC-PO-027 / RT-PAY-1001;
//                            the confirmed address of a first attestation). The stored body holds a
//                            PLACEHOLDER, never the link: the outbox-dispatch job renders it right before
//                            sending (credentialOutboxRender), and refuses to send a link that was used,
//                            revoked or has expired meanwhile. The in-person code of a first attestation is
//                            never emailed (RT-PAY-1201).
import { consumerRegistry, registerConsumer, type DomainEventRecord, type EventConsumer, type RootClient } from '@/modules/platform';
import { credentialLinkIds, credentialLinkPlaceholder, renderCredentialLinkBody } from './credentials';
import { CREDENTIAL_LINK_ISSUED_EVENT, EMAIL_CHANGED_BY_ADMIN_EVENT, RESET_NOTICE_PREVIOUS_EMAIL_EVENT } from './identity';

export const CREDENTIAL_LINK_MAIL_CONSUMER = 'iam.credentialLinkMail';

/** The email of one issued link (pure; Arabic). */
export function credentialLinkMail(purpose: string, tokenId: string, expiresAt: Date): { subject: string; body: string } {
  const until = expiresAt.toISOString().replace('T', ' ').slice(0, 16);
  if (purpose === 'FIRST_ATTESTATION') {
    return {
      subject: 'رديف: تفعيل حسابك واختيار كلمة المرور',
      body: [
        'السلام عليكم،',
        '',
        'أقرّ أحد مسؤولي شركتك بهويتك في نظام رديف. لإتمام الإقرار اختر كلمة مرور جديدة من الرابط التالي:',
        credentialLinkPlaceholder(tokenId),
        '',
        'سيطلب منك الرابط رمزاً من 8 أرقام يسلّمك إياه المسؤول بنفسه (حضورياً أو هاتفياً). لا يُرسل الرمز بالبريد.',
        `الرابط صالح لمرة واحدة حتى ${until} (UTC).`,
        'إن لم تكن تنتظر هذه الرسالة فتجاهلها وأبلغ مسؤول النظام.',
      ].join('\n'),
    };
  }
  return {
    subject: 'رديف: إعادة ضبط بيانات الدخول',
    body: [
      'السلام عليكم،',
      '',
      'طُلبت إعادة ضبط بيانات دخولك إلى نظام رديف، وأُنهيت جلساتك وأُوقفت كلمة المرور السابقة.',
      'اختر كلمة مرور جديدة من الرابط التالي:',
      credentialLinkPlaceholder(tokenId),
      '',
      `الرابط صالح لمرة واحدة حتى ${until} (UTC).`,
      'إن لم تطلب ذلك فأبلغ مسؤول النظام فوراً.',
    ].join('\n'),
  };
}

export const credentialLinkMailConsumer: EventConsumer = {
  name: CREDENTIAL_LINK_MAIL_CONSUMER,
  eventTypes: [CREDENTIAL_LINK_ISSUED_EVENT],
  async handle(event: DomainEventRecord, ctx) {
    const p = (event.payload ?? {}) as { tokenId?: unknown };
    if (typeof p.tokenId !== 'string') return { outcome: 'NOT_APPLICABLE' };
    const row = await ctx.tx.credentialToken.findUnique({ where: { id: p.tokenId }, select: { id: true, purpose: true, sentTo: true, expiresAt: true, usedAt: true, revokedAt: true } });
    if (!row || row.usedAt || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return { outcome: 'LINK_NOT_USABLE' };
    const { enqueueEmails, isOutboxEmailAddress } = await import('@/modules/platform');
    if (!isOutboxEmailAddress(row.sentTo)) return { outcome: 'NO_ADDRESS' };
    const msg = credentialLinkMail(row.purpose, row.id, row.expiresAt);
    const added = await enqueueEmails(ctx.tx, [{ idempotencyKey: `${CREDENTIAL_LINK_MAIL_CONSUMER}:${row.id}`, recipient: row.sentTo, ...msg }]);
    return { outcome: added ? 'QUEUED' : 'ALREADY_QUEUED' };
  },
};

export const ACCOUNT_NOTICE_MAIL_CONSUMER = 'iam.accountNoticeMail';

/**
 * The notice to the PREVIOUS login address (review MEDIUM, DEC-PO-027: the holder must know): after an admin
 * changed it, and after a reset requested soon after such a change. No link, no secret, no new address.
 */
export function accountNoticeMail(type: string): { subject: string; body: string } | null {
  if (type === EMAIL_CHANGED_BY_ADMIN_EVENT) {
    return {
      subject: 'رديف: تغيّر بريد الدخول لحسابك',
      body: [
        'السلام عليكم،',
        '',
        'غيّر أحد مسؤولي شركتك بريد الدخول لحسابك في نظام رديف، فلم يعد هذا البريد يُستخدم لتسجيل الدخول.',
        'إن لم تطلب ذلك فأبلغ إدارة شركتك ورديف فوراً.',
      ].join('\n'),
    };
  }
  if (type === RESET_NOTICE_PREVIOUS_EMAIL_EVENT) {
    return {
      subject: 'رديف: أُعيد ضبط بيانات دخول حسابك',
      body: [
        'السلام عليكم،',
        '',
        'أُعيد ضبط بيانات الدخول لحسابك في نظام رديف بعد وقت قصير من تغيير بريد الدخول بواسطة مسؤول.',
        'أُرسل رابط اختيار كلمة المرور إلى البريد الجديد، لا إلى هذا البريد.',
        'إن لم تطلب ذلك فأبلغ إدارة شركتك ورديف فوراً.',
      ].join('\n'),
    };
  }
  return null;
}

export const accountNoticeMailConsumer: EventConsumer = {
  name: ACCOUNT_NOTICE_MAIL_CONSUMER,
  eventTypes: [EMAIL_CHANGED_BY_ADMIN_EVENT, RESET_NOTICE_PREVIOUS_EMAIL_EVENT],
  async handle(event: DomainEventRecord, ctx) {
    const p = (event.payload ?? {}) as { previousEmail?: unknown };
    const msg = accountNoticeMail(event.type);
    if (!msg) return { outcome: 'NOT_APPLICABLE' };
    const { enqueueEmails, isOutboxEmailAddress } = await import('@/modules/platform');
    if (!isOutboxEmailAddress(typeof p.previousEmail === 'string' ? p.previousEmail : null)) return { outcome: 'NO_ADDRESS' };
    const added = await enqueueEmails(ctx.tx, [{ idempotencyKey: `${ACCOUNT_NOTICE_MAIL_CONSUMER}:${event.idempotencyKey}`, recipient: p.previousEmail as string, ...msg }]);
    return { outcome: added ? 'QUEUED' : 'ALREADY_QUEUED' };
  },
};

export const IAM_CONSUMERS: readonly EventConsumer[] = Object.freeze([credentialLinkMailConsumer, accountNoticeMailConsumer]);

/** Registers iam's DomainEvent consumers (src/jobs/consumers.ts), once. */
export function registerIamConsumers(): void {
  for (const c of IAM_CONSUMERS) if (!consumerRegistry.list().some((r) => r.name === c.name)) registerConsumer(c);
}

/**
 * The outbox render hook (src/jobs/registry.ts): the text to send for a stored message. A message without a
 * credential placeholder is sent as stored; one with a placeholder is sent only while every link it names is
 * still usable (and APP_URL is configured), with the link rendered in memory. null = do not send.
 */
export async function credentialOutboxRender(db: RootClient, message: { body: string }): Promise<string | null> {
  const ids = credentialLinkIds(message.body);
  if (!ids.length) return message.body;
  const rows = await db.credentialToken.findMany({ where: { id: { in: ids } }, select: { id: true, usedAt: true, revokedAt: true, expiresAt: true } });
  const now = Date.now();
  const usable = ids.every((id) => {
    const r = rows.find((x) => x.id === id);
    return !!r && !r.usedAt && !r.revokedAt && r.expiresAt.getTime() > now;
  });
  if (!usable) return null;
  return renderCredentialLinkBody(message.body);
}
