// POC fixture builder. Plays the role of the engine's "render model" step: it turns synthetic
// snapshot data into display strings (amounts, Gregorian + Hijri dates) and assets (QR, logo,
// signature, stamp), so the Typst template only lays out text it receives. Nothing here is
// imported by the app.
//
// Usage: node harness/prepare.mjs   (writes work/<fixture>/{data.json, *.png, qr.svg, main.typ})
import { mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode'); // already a Radeef dependency

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, 'work');

// ---------- tiny RGBA PNG encoder (synthetic assets only) ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const logoPng = png(360, 360, (x, y) => {
  const dx = x - 180, dy = y - 180, r = Math.hypot(dx, dy);
  if (Math.max(Math.abs(dx), Math.abs(dy)) > 170) return [0, 0, 0, 0];
  if (r < 70) return [255, 255, 255, 255];
  if (r < 110 && Math.abs(dx) < 18) return [255, 255, 255, 255];
  return [15, 76, 129, 255];
});
const signaturePng = png(600, 180, (x, y) => {
  const t = x / 600;
  const cy = 90 + Math.sin(t * 19) * 38 * (1 - t) + Math.sin(t * 7) * 20;
  const d = Math.abs(y - cy);
  return d < 3.2 && x > 30 && x < 570 ? [20, 30, 110, Math.round(255 * (1 - d / 3.2))] : [0, 0, 0, 0];
});
const stampPng = png(360, 360, (x, y) => {
  const r = Math.hypot(x - 180, y - 180);
  const ring = (r > 160 && r < 172) || (r > 118 && r < 124) || (r < 40 && ((x + y) % 14 < 7));
  return ring ? [25, 60, 170, 190] : [0, 0, 0, 0];
});

// ---------- display formatting (would live in the engine's render-model step) ----------
const fmtAmount = (v, numerals) =>
  new Intl.NumberFormat(numerals === 'arab' ? 'ar-SA-u-nu-arab' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(Number(v));
const fmtGreg = (iso, numerals, lang = 'ar') =>
  new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : `ar-SA-u-ca-gregory-nu-${numerals}`, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Riyadh' })
    .format(new Date(`${iso}T12:00:00+03:00`));
const fmtHijri = (iso, numerals, lang = 'ar') =>
  new Intl.DateTimeFormat(lang === 'en' ? 'en-u-ca-islamic-umalqura' : `ar-SA-u-ca-islamic-umalqura-nu-${numerals}`, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Riyadh' })
    .format(new Date(`${iso}T12:00:00+03:00`));
// Arabic harakat/tanween (U+064B–U+065F, U+0670). Stripped from data before rendering so the PDF
// text layer stays searchable; the letters themselves are unchanged.
const ARABIC_MARKS = /[\u064B-\u065F\u0670]/g;
const stripMarks = (v) => typeof v === 'string' ? v.replace(ARABIC_MARKS, '')
  : Array.isArray(v) ? v.map(stripMarks)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripMarks(x)])) : v;
const addCents = (rows) => (rows.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0) / 100).toFixed(2);

const baseSalary = [
  { labelAr: 'الراتب الأساسي', labelEn: 'Basic Salary', amount: '9500.00' },
  { labelAr: 'بدل السكن', labelEn: 'Housing Allowance', amount: '2375.00' },
  { labelAr: 'بدل النقل', labelEn: 'Transportation Allowance', amount: '950.00' },
  { labelAr: 'بدلات أخرى', labelEn: 'Other Allowances', amount: '675.50' },
];

function buildModel(o) { return stripMarks(buildModelRaw(o)); }
function buildModelRaw(o) {
  const numerals = o.numerals ?? 'latn';
  const rows = o.salaryRows ?? baseSalary;
  const total = addCents(rows);
  const issued = '2026-09-26';
  const validUntil = '2026-12-25';
  return {
    doc: {
      language: o.language, numerals,
      number: 'ACM-2026-000184',
      titleAr: 'خطاب تعريف بالراتب', titleEn: 'Salary Certificate',
      verifyUrl: `https://acme.radeef.sa/v/${o.token ?? 'K7Q2M9XJ4TRW8PZC3VN6HD5BLA'}`,
      issuedGregorianAr: fmtGreg(issued, numerals), issuedHijriAr: fmtHijri(issued, numerals),
      issuedGregorianEn: fmtGreg(issued, 'latn', 'en'), issuedHijriEn: fmtHijri(issued, 'latn', 'en'),
      validUntilAr: fmtGreg(validUntil, numerals), validUntilEn: fmtGreg(validUntil, 'latn', 'en'),
      pageNumbering: numerals === 'arab' ? '١' : '1',
    },
    company: {
      legalNameAr: 'شركة أكمي للمقاولات العامة المحدودة', legalNameEn: 'ACME General Contracting Co. Ltd.',
      crNumber: '1010123456', unifiedNumber: '7001234567',
      addressAr: 'الرياض، حي العليا، طريق الملك فهد، ص.ب 12345، الرمز البريدي 11564',
      addressEn: 'King Fahd Rd, Al Olaya, Riyadh 11564, P.O. Box 12345',
      phone: '+966 11 234 5678', email: 'hr@acme.example', primaryColor: '#0F4C81',
    },
    addressee: o.addressee ?? { ar: 'إلى من يهمه الأمر', en: 'To Whom It May Concern' },
    employee: {
      fullNameAr: 'محمد عبدالله الأحمد', fullNameEn: 'Mohammed Abdullah Alahmad',
      employeeNumber: 'E-00412', nationalityAr: 'أردني', nationalityEn: 'Jordanian',
      idLabelAr: 'إقامة', idLabelEn: 'Iqama', idNumber: '2456789012', passportNumber: 'N1234567',
      jobTitleAr: 'مهندس مدني أول', jobTitleEn: 'Senior Civil Engineer',
      joinDateAr: fmtGreg('2019-03-10', numerals), joinDateEn: fmtGreg('2019-03-10', 'latn', 'en'),
      ...(o.employee ?? {}),
    },
    salary: {
      currencyAr: 'ريال سعودي', currencyEn: 'SAR',
      rows: rows.map((r) => ({ ...r, amountText: fmtAmount(r.amount, numerals), amountTextEn: fmtAmount(r.amount, 'latn') })),
      total, totalText: fmtAmount(total, numerals), totalTextEn: fmtAmount(total, 'latn'),
    },
    signature: {
      nameAr: 'سارة خالد العتيبي', nameEn: 'Sarah Khalid Alotaibi',
      titleAr: 'مديرة الموارد البشرية', titleEn: 'HR Director',
      printImage: o.printSignature ?? true,
    },
  };
}

const longName = {
  fullNameAr: 'عبدالرحمن بن محمد بن عبدالعزيز بن سليمان بن عبدالله بن إبراهيم آل عبداللطيف',
  fullNameEn: 'Abdulrahman bin Mohammed bin Abdulaziz bin Sulaiman bin Abdullah Al-Abdullatif',
  jobTitleAr: 'أخصائي أول تخطيط وتطوير الموارد البشرية والتحول المؤسسي',
  jobTitleEn: 'Senior Specialist, Human Resources Planning, Development and Organizational Transformation',
};
const stressRows = [
  ...baseSalary,
  ...Array.from({ length: 26 }, (_, i) => ({
    labelAr: `بدل تشغيلي رقم ${i + 1}`, labelEn: `Operational Allowance No. ${i + 1}`, amount: (50 + i * 12.25).toFixed(2),
  })),
];

export const FIXTURES = {
  'F1-ar': buildModel({ language: 'ar' }),
  'F2-ar-en': buildModel({ language: 'ar-en' }),
  'F3-long': buildModel({
    language: 'ar-en', employee: longName,
    addressee: {
      ar: 'سفارة المملكة المتحدة لبريطانيا العظمى وإيرلندا الشمالية — قسم التأشيرات، الرياض',
      en: 'Embassy of the United Kingdom of Great Britain and Northern Ireland — Visa Section, Riyadh',
    },
  }),
  'F4-unauth': buildModel({ language: 'ar', printSignature: false }),
  'F5-arabnum': buildModel({ language: 'ar', numerals: 'arab' }),
  'F6-stress': buildModel({ language: 'ar-en', salaryRows: stressRows }),
  'F7-inject': buildModel({
    language: 'ar-en',
    employee: { fullNameAr: '#read("/etc/passwd") *x* $y$ <l> @ref', fullNameEn: '#panic("boom") _u_ `raw` \\ #let z = 1' },
    addressee: { ar: '#import "@preview/tiaoma:0.3.0": qrcode', en: '= Heading ]] #{ 1 + 1 }' },
  }),
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  rmSync(WORK, { recursive: true, force: true });
  for (const [name, model] of Object.entries(FIXTURES)) {
    const dir = path.join(WORK, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'data.json'), JSON.stringify(model, null, 1));
    writeFileSync(path.join(dir, 'logo.png'), logoPng);
    writeFileSync(path.join(dir, 'signature.png'), signaturePng);
    writeFileSync(path.join(dir, 'stamp.png'), stampPng);
    // Error correction M, quiet zone 4: the engine produces the QR, the renderer only places it.
    writeFileSync(path.join(dir, 'qr.svg'), await QRCode.toString(model.doc.verifyUrl, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 }));
    copyFileSync(path.join(ROOT, 'templates', 'salary-certificate.typ'), path.join(dir, 'main.typ'));
  }
  // Isolation probes: a template that tries to escape its root.
  const probe = path.join(WORK, '_probe');
  mkdirSync(probe, { recursive: true });
  writeFileSync(path.join(probe, 'abs.typ'), '#read("/etc/passwd")\n');
  writeFileSync(path.join(probe, 'parent.typ'), '#read("../F1-ar/data.json")\n');
  writeFileSync(path.join(probe, 'pkg.typ'), '#import "@preview/tiaoma:0.3.0": qrcode\n#qrcode("x")\n');
  console.log(`prepared ${Object.keys(FIXTURES).length} fixtures in ${WORK}`);
}
