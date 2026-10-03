import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, notFound, parseBody } from '@/lib/http';
import { zEmail, zId, zOptText } from '@/lib/validation';
import {
  ALL_COMPANIES,
  OPEN_LINK_STATUSES,
  attestIdentity,
  authz,
  confirmLink,
  credentialCodeFor,
  identityOf,
  identityView,
  namedLinkIntact,
  namedPersonOf,
  rejectLink,
  requestCredentialReset,
  resolveActor,
  runIdentityTransaction,
  scopedContext,
} from '@/modules/iam';
import { moneyActorOf } from '@/modules/platform';
import { loadSecurityPolicy } from '../../../security';

export const dynamic = 'force-dynamic';

// BL-PAY-005: the identity controls of one account, for the tenant's admins (tenant-wide: an admin who sees
// every company, like the other settings/users routes).
//
//   GET   the identity summary, the open employee link, the pending two-person request and the CREDENTIAL
//         HISTORY since launch (email and password changes, resets) that an attester must see first
//         (BR-PAY-005 "كل مُقرّ يرى سجل بيانات الدخول").
//   POST  { action: 'confirmLink' | 'rejectLink', linkId }    the second step of the link
//         { action: 'attest', attestedEmail, emailConfirmed: true, historyReviewed: true, verificationNote }
//               a re-attestation completes at once; a first attestation answers with the 8-digit CODE, shown
//               ONCE, that the attester hands over in person (it is never stored or emailed); the holder
//               completes it with the emailed link + the code. ROOT_ATTEST_OWN (BL-PAY-022, DEC-PO-018: the root
//               and an account Radeef linked to a person the owner named): 202 WITHOUT a code; Radeef releases
//               the code from the vendor panel (RT-PAY-1301: the root never holds both channels).
//         { action: 'resetCredentials', reason? }               identity.resetCredentials (202 when a second
//               person must approve it, DEC-PO-024)
// The operation key: the Idempotency-Key header, else a fresh one (a double click with the header replays).

type Ctx = { params: Promise<{ id: string }> };

const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirmLink'), linkId: zId }),
  z.object({ action: z.literal('rejectLink'), linkId: zId }),
  z.object({
    action: z.literal('attest'),
    attestedEmail: zEmail,
    emailConfirmed: z.literal(true, { errorMap: () => ({ message: 'يجب أن تؤكد صراحةً أن البريد يخص هذا الشخص' }) }),
    historyReviewed: z.literal(true, { errorMap: () => ({ message: 'يجب الاطلاع على سجل بيانات الدخول قبل الإقرار' }) }),
    verificationNote: z.string().trim().min(10, 'اكتب كيف تحققت من الشخص خارج النظام (10 أحرف على الأقل)').max(1000),
  }),
  z.object({ action: z.literal('resetCredentials'), reason: zOptText(500) }),
]);

async function adminContext() {
  const actor = await requireUser(ROLE_GROUPS.ADMIN);
  const ctx = scopedContext(await resolveActor(prisma, actor), ALL_COMPANIES);
  authz.assert(ctx, 'platform.settings.manage');
  return actor;
}

const CREDENTIAL_ACTIONS = [
  'iam.user.create',
  'iam.user.change',
  'iam.identity.promoteApprover',
  'iam.identity.resetCredentials',
  'iam.identity.completeCredentialSetup',
  'iam.identity.attest',
  'iam.identity.attest.started',
  'iam.self.changePassword',
  'iam.self.changeEmail',
  'iam.self.rehashPassword',
];

/** Credential changes of the account since launch: the identity records, then the legacy log entries. */
async function credentialHistory(userId: string) {
  const [records, legacy] = await Promise.all([
    prisma.auditRecord.findMany({
      where: { entityType: 'User', entityId: userId, action: { in: CREDENTIAL_ACTIONS } },
      orderBy: { occurredAt: 'desc' },
      take: 100,
      select: { id: true, action: true, actorId: true, actorType: true, occurredAt: true, after: true },
    }),
    prisma.auditLog.findMany({
      where: { entityType: 'User', entityId: userId, action: { in: ['CREATE', 'UPDATE', 'PASSWORD_RESET'] } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, action: true, userId: true, createdAt: true, details: true },
    }),
  ]);
  const legacyCredential = legacy.filter((l) => l.action !== 'UPDATE' || /"(email|credentialsReset|password|field)"/.test(l.details ?? ''));
  return [
    ...records.map((r) => ({ source: 'record', id: r.id, action: r.action, actorId: r.actorId, at: r.occurredAt, after: r.after })),
    ...legacyCredential.map((l) => ({ source: 'legacy', id: l.id, action: l.action, actorId: l.userId, at: l.createdAt, after: l.details })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

export async function GET(_req: Request, { params }: Ctx) {
  try {
    await adminContext();
    const id = zId.parse((await params).id);
    const identity = await identityOf(prisma, id);
    if (!identity) throw notFound('المستخدم غير موجود');
    const [link, pending, history, named] = await Promise.all([
      prisma.userEmployeeLink.findFirst({
        where: { userId: id, status: { in: [...OPEN_LINK_STATUSES] } },
        select: { id: true, employeeId: true, status: true, proposedById: true, proposedAt: true, employee: { select: { firstNameArabic: true, lastNameArabic: true, employeeId: true } } },
      }),
      prisma.identityChangeRequest.findFirst({ where: { userId: id, status: 'PENDING' }, select: { id: true, kind: true, nextRole: true, requestedById: true, requestedAt: true, reason: true } }),
      credentialHistory(id),
      namedPersonOf(prisma, id),
    ]);
    // The owner's named-person list entry (read only; written by Radeef's vendor panel, BL-PAY-022): shown to the
    // root, who may attest the account under ROOT_ATTEST_OWN while the link is intact. No national id, no hash.
    const namedPerson = named ? { email: named.email, requestRef: named.requestRef, linkedAt: named.linkedAt, intact: namedLinkIntact(named, identity) } : null;
    return NextResponse.json({ userId: id, email: identity.email, identity: identityView(identity), namedPerson, employeeLink: link, pendingChange: pending, credentialHistory: history });
  } catch (err) {
    return handleApiError(err, 'users:[id]:identity:GET');
  }
}

export async function POST(req: Request, { params }: Ctx) {
  try {
    const actor = await adminContext();
    const id = zId.parse((await params).id);
    const body = await parseBody(req, ActionSchema);
    const me = moneyActorOf(actor);
    const ip = getClientIp(req);
    const idem = req.headers.get('idempotency-key')?.slice(0, 100) || randomUUID();
    const key = `users.identity.${body.action}:${actor.id}:${id}:${idem}`;

    if (body.action === 'confirmLink' || body.action === 'rejectLink') {
      const link = await prisma.userEmployeeLink.findUnique({ where: { id: body.linkId }, select: { userId: true } });
      if (!link || link.userId !== id) throw notFound('طلب الربط غير موجود');
      if (body.action === 'confirmLink') {
        const r = await runIdentityTransaction(prisma, (tx) => confirmLink(tx, { actor: me, linkId: body.linkId, operationKey: key, ipAddress: ip }));
        return NextResponse.json({
          message: r.selfAct ? 'تم تأكيد الربط وتسجيله كتصرف منفرد (وضع المشغّل الواحد)' : 'تم تأكيد ربط الحساب بملف الموظف',
          link: r.link,
          selfAct: r.selfAct,
          replayed: r.replayed,
        });
      }
      const r = await runIdentityTransaction(prisma, (tx) => rejectLink(tx, { actor: me, linkId: body.linkId, operationKey: key, ipAddress: ip }));
      return NextResponse.json({ message: r.link.status === 'CANCELLED' ? 'تم سحب طلب الربط' : 'تم رفض طلب الربط', link: r.link, replayed: r.replayed });
    }

    const { credentialLinkHours } = await loadSecurityPolicy();
    if (body.action === 'attest') {
      const r = await runIdentityTransaction(prisma, (tx) =>
        attestIdentity(tx, {
          actor: me,
          userId: id,
          attestedEmail: body.attestedEmail,
          emailConfirmed: body.emailConfirmed,
          historyReviewed: body.historyReviewed,
          verificationNote: body.verificationNote,
          linkHours: credentialLinkHours,
          operationKey: key,
          ipAddress: ip,
        }),
      );
      if (r.status === 'PENDING_SETUP' && r.tokenId && r.codeDelivery === 'VENDOR') {
        return NextResponse.json(
          {
            message:
              'بدأ إقرار الجذر لشخص سمّاه المالك (ROOT_ATTEST_OWN): أُرسل رابط لمرة واحدة إلى البريد الذي سجّلته رديف، وتسلّم رديف الرمز لصاحب الحساب مباشرة. لا يُعد الحساب مُقرّاً به قبل أن يستخدم الرابط والرمز معاً.',
            status: r.status,
            rootAttestOwn: true,
            expiresAt: r.expiresAt,
            replayed: r.replayed,
          },
          { status: 202, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      if (r.status === 'PENDING_SETUP' && r.tokenId) {
        return NextResponse.json(
          {
            message:
              'بدأ الإقرار الأول: أُرسل رابط لمرة واحدة إلى البريد المُقرّ. سلّم الرمز التالي لصاحب الحساب بنفسك (حضورياً أو هاتفياً)، ولا ترسله بالبريد. لا يُعد الحساب مُقرّاً به قبل أن يستخدم الرابط والرمز معاً.',
            status: r.status,
            // Derived from the link row and the server key; never stored. Shown to the attester only.
            code: credentialCodeFor(r.tokenId),
            expiresAt: r.expiresAt,
            replayed: r.replayed,
          },
          { status: 202, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      return NextResponse.json({ message: 'تم إقرار هوية الحساب', status: r.status, replayed: r.replayed });
    }

    const r = await runIdentityTransaction(prisma, (tx) =>
      requestCredentialReset(tx, { actor: me, userId: id, reason: body.reason ?? null, linkHours: credentialLinkHours, operationKey: key, ipAddress: ip }),
    );
    if (!r.executed) {
      return NextResponse.json(
        {
          message: 'هذا الحساب يُحسب ضمن المعتمدين الماليين المُقرّين: إعادة الضبط تحتاج موافقة صاحبه أو مسؤول آخر مُقرّ به (DEC-PO-024)، وأُرسلت طلباً بانتظار الموافقة',
          request: r.request,
          replayed: r.replayed,
        },
        { status: 202 },
      );
    }
    return NextResponse.json({
      message: 'تمت إعادة ضبط بيانات الدخول: أُنهيت الجلسات وأُوقفت كلمة المرور، ويصل صاحب الحساب رابط لمرة واحدة يختار به كلمة مرور جديدة. لا يعيد إقراره إلا جذر الثقة.',
      request: r.request,
      replayed: r.replayed,
    });
  } catch (err) {
    return handleApiError(err, 'users:[id]:identity:POST');
  }
}
