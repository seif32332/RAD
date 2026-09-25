'use strict';
/**
 * License e-mail alerts (SMTP_* env of the PANEL, not of the tenants).
 * sendAlertEmail() never throws: it resolves to { sent, reason?, messageId? } so the caller can
 * record the outcome in the per-day notice registry (store.claimNotice / setNoticeOutcome).
 */
const nodemailer = require('nodemailer');

const WHATSAPP_URL = process.env.SUPPORT_WHATSAPP_URL || 'https://wa.me/966593119252';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function card({ border, bg, titleColor, title, paragraphs, cta }) {
  return `
    <div dir="rtl" style="font-family: 'Cairo', Tahoma, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid ${border}; border-radius: 10px; background-color: ${bg};">
      <h2 style="color: ${titleColor}; text-align: center; border-bottom: 2px solid ${border}; padding-bottom: 10px;">${title}</h2>
      <p style="font-size: 16px; color: #4a5568; line-height: 1.6;">عزيزنا العميل،</p>
      ${paragraphs.map((p) => `<p style="font-size: 15px; color: #4a5568; line-height: 1.6;">${p}</p>`).join('\n')}
      <div style="text-align: center; margin: 30px 0;">
        <a href="${esc(WHATSAPP_URL)}" style="background-color: #25d366; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px;">${cta}</a>
      </div>
      <hr style="border: 0; border-top: 1px solid ${border}; margin: 20px 0;" />
      <p style="font-size: 12px; color: #a0aec0; text-align: center;">هذه الرسالة تم توليدها تلقائياً من نظام إدارة تراخيص رديف.</p>
    </div>`;
}

/** "اليوم هو آخر يوم" / "متبقي يوم واحد" / "متبقي N يوماً". */
function remainingText(days) {
  if (days <= 0) return 'اليوم هو آخر يوم في الاشتراك';
  if (days === 1) return 'متبقي يوم واحد';
  if (days === 2) return 'متبقي يومان';
  return `متبقي ${days} يوماً`;
}

/**
 * type: 'warning' (with opts.days), 'expired', or the legacy 'warning_7' / 'warning_2'.
 * The license is suspended only AFTER the end date has passed (days < 0), never on the last
 * paid day itself.
 */
function buildMessage(tenant, type, opts = {}) {
  const name = esc(tenant.name);
  const domain = esc(tenant.domain);
  const endDate = esc(tenant.end_date);
  const link = `<a href="https://${domain}" style="color: #2b6cb0; text-decoration: none;">${domain}</a>`;
  let days = Number.isFinite(opts.days) ? opts.days : null;
  if (type === 'warning_7') days = 7;
  if (type === 'warning_2') days = 2;
  if (type !== 'expired') {
    const d = days === null ? 14 : Math.max(0, days);
    const urgent = d <= 2;
    return {
      subject: urgent
        ? `تنبيه هام: ${remainingText(d)} على انتهاء اشتراك نسخة ${tenant.name}`
        : `تنبيه: ${remainingText(d)} على انتهاء اشتراك نسخة ${tenant.name}`,
      html: card({
        border: urgent ? '#feb2b2' : '#e2e8f0',
        bg: '#ffffff',
        titleColor: urgent ? '#e53e3e' : '#2b6cb0',
        title: urgent ? 'تنبيه هام: اقترب انتهاء الاشتراك' : 'تنبيه بقرب انتهاء الاشتراك',
        paragraphs: [
          `نود تذكيرك بأن اشتراك نسخة النظام الخاصة بك <strong>(${name})</strong> المربوطة بالنطاق (${link}) ينتهي في تاريخ <strong>${endDate}</strong> (${esc(remainingText(d))}).`,
          `يعمل النظام حتى نهاية يوم ${endDate}، وفي حال عدم التجديد يتوقف تلقائياً بعد انقضاء هذا اليوم.`,
          'يرجى التواصل مع إدارة النظام لتجديد الاشتراك لضمان استمرار الخدمة دون انقطاع.',
        ],
        cta: urgent ? 'تجديد الاشتراك الآن' : 'تواصل للتجديد عبر واتساب',
      }),
    };
  }
  return {
    subject: `إشعار: تم إيقاف نسخة ${tenant.name} لانتهاء الاشتراك`,
    html: card({
      border: '#feb2b2',
      bg: '#fff5f5',
      titleColor: '#c53030',
      title: 'تم إيقاف الاشتراك لتجاوز تاريخ الصلاحية',
      paragraphs: [
        `نحيطك علماً بأن اشتراك نسخة النظام الخاصة بك <strong>(${name})</strong> قد انتهى في تاريخ <strong>${endDate}</strong> وبناءً عليه تم إيقاف الخدمة تلقائياً.`,
        'بياناتك محفوظة ولم يُحذف منها شيء. لتفعيل الخدمة مجدداً يرجى التواصل مع إدارة النظام.',
      ],
      cta: 'تواصل معنا للتجديد الفوري',
    }),
  };
}

function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

async function sendAlertEmail(tenant, type, opts = {}) {
  if (!smtpConfigured()) {
    console.warn('[LMS] SMTP configuration missing. Skipping email send.');
    return { sent: false, reason: 'smtp_not_configured' };
  }
  const to = tenant.client_email || process.env.DEFAULT_CLIENT_EMAIL;
  if (!to) {
    console.warn(`[LMS] No client e-mail for ${tenant.name}. Skipping email send.`);
    return { sent: false, reason: 'no_recipient' };
  }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });
  const { subject, html } = buildMessage(tenant, type, opts);
  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || `"إدارة تراخيص رديف" <${process.env.SMTP_USER}>`,
      to,
      cc: process.env.SMTP_USER,
      subject,
      html,
    });
    console.log(`[LMS] Email (${type}) sent for ${tenant.name}: ${info.messageId}`);
    return { sent: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[LMS] Failed to send email alert for ${tenant.name}:`, error.message);
    return { sent: false, reason: `error: ${error.message}` };
  }
}

module.exports = { sendAlertEmail, buildMessage, remainingText, smtpConfigured };
