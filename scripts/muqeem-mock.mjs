#!/usr/bin/env node
// Local mock of Elm's Muqeem API (docs/integrations/muqeem/muqeem-api.json, v1.9). Dependency-free.
// FOR LOCAL DEVELOPMENT AND TESTS ONLY: it is not the real service and proves nothing about it.
//
//   node scripts/muqeem-mock.mjs
//   # then run the app with:
//   #   MUQEEM_ENABLED=true MUQEEM_BASE_URL=http://127.0.0.1:4010 MUQEEM_APP_ID=local-mock-app MUQEEM_APP_KEY=local-mock-key
//
// Env:
//   MUQEEM_MOCK_PORT            default 4010 (listens on 127.0.0.1 only)
//   MUQEEM_MOCK_APP_ID          default 'local-mock-app'
//   MUQEEM_MOCK_APP_KEY         default 'local-mock-key'
//   MUQEEM_MOCK_USERNAME        default 'mock-user'
//   MUQEEM_MOCK_PASSWORD        default 'mock-pass'
//   MUQEEM_MOCK_INTEGRATOR_ID   when set, X-INTEGRATOR-ID must equal it (integrator mode)
//   MUQEEM_MOCK_TOKEN_TTL       token lifetime in seconds, default 3600
//   MUQEEM_MOCK_HANG_MS         delay for the '9999' simulation, default 30000
//   MUQEEM_MOCK_FIXTURES        path of a JSON array of residents for the active residents report
//
// Behaviour:
//   - every path of the spec is implemented; response property names follow the spec's schemas;
//   - app-id / app-key headers are required on every call (also accepted as app_id / app_key);
//     every /api/v1/* call requires Authorization: Bearer <id_token from /api/authenticate>;
//   - required request fields (and their spec patterns) are validated: 400 { message };
//   - simulations by iqamaNumber / borderNumber suffix:
//       '0000' -> 422 { message: 'الإقامة غير مؤهلة للخدمة' }
//       '9999' -> the response is delayed by MUQEEM_MOCK_HANG_MS (past the client timeout), then the
//                 operation IS executed (like a real server that finished after the client gave up)
//       '5003' -> 503 { message: 'Service Unavailable' } (not executed)
//   - state (issued visas, renewed iqamas, passports, interactive services log) is kept in memory;
//     a resident absent from the fixtures gets the passport number its first passport request names;
//   - every /api/v1/* request that reaches a handler is counted (state.requests: path, id, time),
//     also the ones that fail or hang, so tests can prove that a request never reached Muqeem;
//   - extras: GET /__mock/state (dump), POST /__mock/reset.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, randomInt } from 'node:crypto';

const PORT = Number(process.env.MUQEEM_MOCK_PORT || 4010);
const APP_ID = process.env.MUQEEM_MOCK_APP_ID || 'local-mock-app';
const APP_KEY = process.env.MUQEEM_MOCK_APP_KEY || 'local-mock-key';
const USERNAME = process.env.MUQEEM_MOCK_USERNAME || 'mock-user';
const PASSWORD = process.env.MUQEEM_MOCK_PASSWORD || 'mock-pass';
const INTEGRATOR_ID = process.env.MUQEEM_MOCK_INTEGRATOR_ID || '';
const TOKEN_TTL_S = Number(process.env.MUQEEM_MOCK_TOKEN_TTL || 3600);
const HANG_MS = Number(process.env.MUQEEM_MOCK_HANG_MS || 30000);
const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const HIJRI = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
const todayUtc = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
const g = (d) => d.toISOString().slice(0, 10);
function h(d) {
  const p = HIJRI.formatToParts(d);
  const get = (t) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('year').replace(/\D/g, '')}-${get('month')}-${get('day')}`;
}
function hijriToGregorian(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const est = Date.UTC(2023, 6, 19) + Math.round((y - 1445) * 354.36707 + (m - 1) * 29.530589 + (d - 1)) * DAY_MS;
  for (let o = 0; o <= 40; o++) {
    for (const sign of o === 0 ? [0] : [-1, 1]) {
      const c = new Date(est + sign * o * DAY_MS);
      if (h(c) === s) return c;
    }
  }
  return null;
}
const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);
function addMonths(d, n) {
  const r = new Date(d);
  r.setUTCMonth(r.getUTCMonth() + n);
  return r;
}

// ---------------------------------------------------------------------------
// Tiny valid PDF (base64)
// ---------------------------------------------------------------------------

function pdfBase64(label) {
  const text = String(label).replace(/[^A-Za-z0-9 :#_-]/g, '').slice(0, 60);
  const content = `BT /F1 14 Tf 24 100 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 160] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1').toString('base64');
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const DEFAULT_RESIDENTS = [
  { iqamaNumber: '2400000001', residentName: 'محمد عبدالله خان', translatedResidentName: 'MOHAMMED ABDULLAH KHAN', nationality: 'باكستان', occupation: 'محاسب', iqamaExpiryDateG: '2027-03-15', passportNumber: 'AB1234567', passportExpiryDateG: '2029-01-10' },
  { iqamaNumber: '2400000002', residentName: 'راجيش كومار', translatedResidentName: 'RAJESH KUMAR', nationality: 'الهند', occupation: 'فني كهرباء', iqamaExpiryDateG: '2026-11-02', passportNumber: 'Z9876543', passportExpiryDateG: '2027-06-30' },
  { iqamaNumber: '2400000003', residentName: 'أحمد محمود السيد', translatedResidentName: 'AHMED MAHMOUD ELSAYED', nationality: 'مصر', occupation: 'مهندس مدني', iqamaExpiryDateG: '2026-10-20', passportNumber: 'A12345678', passportExpiryDateG: '2028-08-01' },
  { iqamaNumber: '2400000004', residentName: 'خوسيه سانتوس', translatedResidentName: 'JOSE SANTOS', nationality: 'الفلبين', occupation: 'ممرض', iqamaExpiryDateG: '2027-01-05', passportNumber: 'P7654321A', passportExpiryDateG: '2030-02-14' },
  { iqamaNumber: '2400000005', residentName: 'عبدالرحمن حسن', translatedResidentName: 'ABDULRAHMAN HASSAN', nationality: 'السودان', occupation: 'سائق', iqamaExpiryDateG: '2026-12-12', passportNumber: 'SD1122334', passportExpiryDateG: '2027-12-31' },
];

function loadResidents() {
  const file = process.env.MUQEEM_MOCK_FIXTURES;
  if (!file) return DEFAULT_RESIDENTS.map((r) => ({ ...r }));
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(data)) throw new Error('MUQEEM_MOCK_FIXTURES must contain a JSON array');
  return data;
}

const CITIES = [
  { code: '1', nameAr: 'الرياض', nameEn: 'Riyadh' },
  { code: '2', nameAr: 'جدة', nameEn: 'Jeddah' },
  { code: '3', nameAr: 'مكة المكرمة', nameEn: 'Makkah' },
  { code: '4', nameAr: 'المدينة المنورة', nameEn: 'Madinah' },
  { code: '5', nameAr: 'الدمام', nameEn: 'Dammam' },
];
const COUNTRIES = [
  { code: '113', nameAr: 'السعودية', nameEn: 'Saudi Arabia' },
  { code: '301', nameAr: 'مصر', nameEn: 'Egypt' },
  { code: '401', nameAr: 'الهند', nameEn: 'India' },
  { code: '402', nameAr: 'باكستان', nameEn: 'Pakistan' },
  { code: '403', nameAr: 'بنجلاديش', nameEn: 'Bangladesh' },
  { code: '501', nameAr: 'الفلبين', nameEn: 'Philippines' },
  { code: '304', nameAr: 'السودان', nameEn: 'Sudan' },
];
const MARITAL_STATUSES = [
  { code: '1', nameAr: 'أعزب', nameEn: 'Single' },
  { code: '2', nameAr: 'متزوج', nameEn: 'Married' },
  { code: '3', nameAr: 'مطلق', nameEn: 'Divorced' },
  { code: '4', nameAr: 'أرمل', nameEn: 'Widowed' },
];

let state;
function resetState() {
  state = {
    residents: loadResidents(),
    tokens: new Map(), // token -> exp (s)
    visas: new Map(), // visaNumber -> visa
    iqamas: new Map(), // iqamaNumber -> { expiry: Date, version: number }
    passports: new Map(), // iqamaNumber -> { number, expiry }
    log: [], // interactive services report rows
    requests: [], // every /api/v1/* call received: { at, path, id }
  };
}
resetState();

function resident(iqamaNumber) {
  const r = state.residents.find((x) => String(x.iqamaNumber) === String(iqamaNumber));
  if (r) return r;
  return {
    iqamaNumber,
    residentName: 'مقيم تجريبي',
    translatedResidentName: 'MOCK RESIDENT',
    nationality: 'الهند',
    occupation: 'عامل',
    iqamaExpiryDateG: g(addDays(todayUtc(), 200)),
    passportNumber: 'M' + String(iqamaNumber).slice(-7),
    passportExpiryDateG: g(addDays(todayUtc(), 900)),
  };
}
function iqamaInfo(iqamaNumber) {
  if (!state.iqamas.has(iqamaNumber)) {
    const r = resident(iqamaNumber);
    state.iqamas.set(iqamaNumber, { expiry: new Date(`${r.iqamaExpiryDateG || g(addDays(todayUtc(), 200))}T00:00:00Z`), version: 1 });
  }
  return state.iqamas.get(iqamaNumber);
}
/**
 * Passport of a resident. For a resident absent from the fixtures (tests create them at will), the
 * first passport request fixes the number (`claimed`), so passport updates (including the delayed
 * '9999' ones) execute instead of failing on an invented number.
 */
function passportInfo(iqamaNumber, claimed) {
  if (!state.passports.has(iqamaNumber)) {
    const known = state.residents.find((x) => String(x.iqamaNumber) === String(iqamaNumber));
    const r = resident(iqamaNumber);
    const number = !known && typeof claimed === 'string' && claimed ? claimed : r.passportNumber || 'M0000000';
    state.passports.set(iqamaNumber, { number, expiry: new Date(`${r.passportExpiryDateG || g(addDays(todayUtc(), 900))}T00:00:00Z`) });
  }
  return state.passports.get(iqamaNumber);
}
const lookup = (ar, en, code) => ({ ar, code, en });
const newVisaNumber = () => String(randomInt(1, 10)) + String(randomInt(0, 1e9)).padStart(9, '0');
const newRequestNumber = () => String(Date.now()) + String(randomInt(0, 1000)).padStart(3, '0');

function logService(req, type, description, iqamaNumber, errorMessage = '') {
  const now = new Date();
  state.log.push({
    company: 'مؤسسة تجريبية',
    date: `${g(now)} ${now.toISOString().slice(11, 19)}`,
    description,
    errorMessage,
    iqamaNumber: iqamaNumber || '',
    requestNumber: newRequestNumber(),
    type,
    user: req.muqeemUser || USERNAME,
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, body) {
    super(body.message || 'error');
    this.status = status;
    this.body = body;
  }
}
const bad = (message) => new ApiError(400, { message, title: 'Bad Request', status: 400 });
const business = (message) => new ApiError(422, { message, title: 'Unprocessable Entity', status: 422 });

const P = {
  iqama: /^2[0-9]{9}$/,
  border: /^(3|4|5)[0-9]{9}$/,
  visaNumber: /^[0-9]{1,250}$/,
  moi: /^(1|2|7)[0-9]{9}$/,
  passport: /^[A-Za-z0-9]{1,15}$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  iqamaDuration: /^(3|6|9|12|15|18|21|24)$/,
  lang: /^(ar|en)$/,
  print: null,
};

/** rules: { field: pattern | null (required, no pattern) }, optional: { field: pattern } */
function validate(body, required, optional = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('جسم الطلب يجب أن يكون كائن JSON');
  const missing = Object.keys(required).filter((k) => body[k] === undefined || body[k] === null || body[k] === '');
  if (missing.length) throw bad(`حقول مطلوبة مفقودة: ${missing.join(', ')}`);
  for (const [k, re] of Object.entries({ ...required, ...optional })) {
    const v = body[k];
    if (v === undefined || v === null || !re) continue;
    if (!re.test(String(v))) throw bad(`قيمة غير صالحة للحقل: ${k}`);
  }
}

/** Failure simulation by id suffix. Returns after an optional hang. */
async function simulate(id) {
  const s = String(id ?? '');
  if (s.endsWith('0000')) throw business('الإقامة غير مؤهلة للخدمة');
  if (s.endsWith('5003')) throw new ApiError(503, { message: 'Service Unavailable', status: 503 });
  if (s.endsWith('9999')) await new Promise((r) => setTimeout(r, HANG_MS));
}

// ---------------------------------------------------------------------------
// Handlers (path -> async (body, req, url) => response body)
// ---------------------------------------------------------------------------

function visaOf(visaNumber, iqamaNumber, kind) {
  const v = state.visas.get(String(visaNumber));
  if (!v || v.iqamaNumber !== iqamaNumber || v.kind !== kind) throw business('التأشيرة غير موجودة لهذا المقيم');
  return v;
}

const V1 = {
  async 'exit-reentry/issue'(b, req) {
    validate(b, { iqamaNumber: P.iqama, visaType: null });
    if (![1, 2].includes(Number(b.visaType))) throw bad('قيمة غير صالحة للحقل: visaType');
    await simulate(b.iqamaNumber);
    const today = todayUtc();
    let duration;
    let returnBefore;
    if (b.returnBefore !== undefined && b.returnBefore !== null) {
      returnBefore = hijriToGregorian(String(b.returnBefore));
      if (!returnBefore) throw bad('قيمة غير صالحة للحقل: returnBefore (yyyy-MM-dd هجري)');
      duration = Math.round((returnBefore - today) / DAY_MS);
    } else if (b.visaDuration !== undefined) {
      duration = Number(b.visaDuration);
      if (!Number.isInteger(duration)) throw bad('قيمة غير صالحة للحقل: visaDuration');
      returnBefore = addDays(today, duration);
    } else {
      throw bad('حقول مطلوبة مفقودة: visaDuration أو returnBefore');
    }
    if (duration < 7) throw business('مدة التأشيرة يجب ألا تقل عن 7 أيام');
    const active = [...state.visas.values()].find((v) => v.iqamaNumber === b.iqamaNumber && v.kind === 'ER' && v.status === 'ISSUED');
    if (active) throw business('يوجد تأشيرة خروج وعودة سارية لهذا المقيم');
    const r = resident(b.iqamaNumber);
    const visaNumber = newVisaNumber();
    const travelBefore = returnBefore < addDays(today, 90) ? returnBefore : addDays(today, 90);
    const visa = { kind: 'ER', visaNumber, iqamaNumber: b.iqamaNumber, visaType: Number(b.visaType), duration, returnBefore, travelBefore, status: 'ISSUED', issuedAt: new Date().toISOString() };
    state.visas.set(visaNumber, visa);
    logService(req, 'إصدار تأشيرة خروج وعودة', `تأشيرة رقم ${visaNumber}`, b.iqamaNumber);
    return {
      ervisaPDF: pdfBase64(`Muqeem MOCK exit re-entry visa ${visaNumber}`),
      iqamaNumber: b.iqamaNumber,
      residentName: r.residentName,
      translatedResidentName: r.translatedResidentName,
      travelBeforeGregorian: g(travelBefore),
      travelBeforeHijri: h(travelBefore),
      visaDuration: duration,
      visaNumber,
      visaReturnBeforeGregorianDate: g(returnBefore),
      visaReturnBeforeHijriDate: h(returnBefore),
      visaType: visa.visaType === 2 ? 'Multiple' : 'Single',
    };
  },

  async 'exit-reentry/extend'(b, req) {
    validate(b, { iqamaNumber: P.iqama, returnBefore: null, visaDuration: null, visaNumber: P.visaNumber });
    await simulate(b.iqamaNumber);
    const v = visaOf(b.visaNumber, b.iqamaNumber, 'ER');
    if (v.status !== 'ISSUED') throw business('لا يمكن تمديد تأشيرة ملغاة');
    const newReturn = hijriToGregorian(String(b.returnBefore));
    if (!newReturn) throw bad('قيمة غير صالحة للحقل: returnBefore (yyyy-MM-dd هجري)');
    const extra = Number(b.visaDuration);
    if (!Number.isInteger(extra) || extra < 7) throw bad('قيمة غير صالحة للحقل: visaDuration (7 أيام على الأقل)');
    if (newReturn <= v.returnBefore) throw business('تاريخ العودة الجديد يجب أن يكون بعد تاريخ العودة الحالي');
    const before = { duration: v.duration, returnBefore: v.returnBefore };
    v.duration += extra;
    v.returnBefore = newReturn;
    const r = resident(b.iqamaNumber);
    const iq = iqamaInfo(b.iqamaNumber);
    const pp = passportInfo(b.iqamaNumber);
    logService(req, 'تمديد تأشيرة خروج وعودة', `تأشيرة رقم ${v.visaNumber}`, b.iqamaNumber);
    return {
      iqamaExpiryDateG: g(iq.expiry),
      iqamaExpiryDateH: h(iq.expiry),
      iqamaNumber: b.iqamaNumber,
      passportExpiryDateG: g(pp.expiry),
      passportExpiryDateH: h(pp.expiry),
      passportNumber: pp.number,
      requestedExtendedDuration: extra,
      residentName: r.residentName,
      returnBeforeAfterExtensionG: g(newReturn),
      returnBeforeAfterExtensionH: h(newReturn),
      returnBeforeBeforeExtensionG: g(before.returnBefore),
      returnBeforeBeforeExtensionH: h(before.returnBefore),
      serviceCost: v.visaType === 2 ? 200 * Math.ceil(extra / 90) : 100 * Math.ceil(extra / 30),
      travelBeforeDateG: g(v.travelBefore),
      travelBeforeDateH: h(v.travelBefore),
      visaDurationBeforeExtension: before.duration,
      visaNumber: v.visaNumber,
      visaType: v.visaType === 2 ? lookup('متعددة', 'Multiple', '2') : lookup('مفردة', 'Single', '1'),
    };
  },

  async 'exit-reentry/cancel'(b, req) {
    validate(b, { erVisaNumber: P.visaNumber, iqamaNumber: P.iqama });
    await simulate(b.iqamaNumber);
    const v = visaOf(b.erVisaNumber, b.iqamaNumber, 'ER');
    if (v.status !== 'ISSUED') throw business('التأشيرة ملغاة مسبقاً');
    v.status = 'CANCELLED';
    const r = resident(b.iqamaNumber);
    logService(req, 'إلغاء تأشيرة خروج وعودة', `تأشيرة رقم ${v.visaNumber}`, b.iqamaNumber);
    return {
      iqamaNumber: b.iqamaNumber,
      residentName: r.residentName,
      transaltedResidentName: r.translatedResidentName,
      translatedResidentName: r.translatedResidentName,
      visaNumber: v.visaNumber,
      visaStatus: 'Cancelled',
    };
  },

  async 'exit-reentry/reprint'(b, req) {
    validate(b, { iqamaNumber: P.iqama, visaNumber: P.visaNumber });
    await simulate(b.iqamaNumber);
    const v = visaOf(b.visaNumber, b.iqamaNumber, 'ER');
    logService(req, 'إعادة طباعة تأشيرة خروج وعودة', `تأشيرة رقم ${v.visaNumber}`, b.iqamaNumber);
    return {
      ervisaPDF: pdfBase64(`Muqeem MOCK exit re-entry visa ${v.visaNumber} (reprint)`),
      iqamaNumber: b.iqamaNumber,
      residentName: resident(b.iqamaNumber).residentName,
      visaNumber: v.visaNumber,
    };
  },

  async 'final-exit/issue'(b, req) {
    validate(b, { iqamaNumber: P.iqama });
    await simulate(b.iqamaNumber);
    const existing = [...state.visas.values()].find((v) => v.iqamaNumber === b.iqamaNumber && v.kind === 'FE' && v.status === 'ISSUED');
    if (existing) throw business('يوجد تأشيرة خروج نهائي سارية لهذا المقيم');
    const visaNumber = newVisaNumber();
    const today = todayUtc();
    const visa = { kind: 'FE', visaNumber, iqamaNumber: b.iqamaNumber, visaType: Number(b.visaType ?? 1), issuedOn: today, exitBefore: addDays(today, 60), status: 'ISSUED' };
    state.visas.set(visaNumber, visa);
    logService(req, 'إصدار تأشيرة خروج نهائي', `تأشيرة رقم ${visaNumber}`, b.iqamaNumber);
    return { mainResident: feMainResident(visa, 'Issued') };
  },

  async 'final-exit/cancel'(b, req) {
    validate(b, { feVisaNumber: P.visaNumber, iqamaNumber: P.iqama });
    await simulate(b.iqamaNumber);
    const v = visaOf(b.feVisaNumber, b.iqamaNumber, 'FE');
    if (v.status !== 'ISSUED') throw business('التأشيرة ملغاة مسبقاً');
    v.status = 'CANCELLED';
    logService(req, 'إلغاء تأشيرة خروج نهائي', `تأشيرة رقم ${v.visaNumber}`, b.iqamaNumber);
    return { mainResident: feMainResident(v, 'Cancelled') };
  },

  async 'final-exit/issue/probation-period'(b, req) {
    validate(b, { borderNumber: P.border, maritalStatus: null, passportIssueCity: null, trFamilyName: null, trFatherName: null, trFirstName: null, trGrandFatherName: null });
    await simulate(b.borderNumber);
    const visaNumber = newVisaNumber();
    const today = todayUtc();
    state.visas.set(visaNumber, { kind: 'FE', visaNumber, iqamaNumber: b.borderNumber, visaType: 1, issuedOn: today, exitBefore: addDays(today, 60), status: 'ISSUED' });
    logService(req, 'إصدار خروج نهائي خلال فترة التجربة', `تأشيرة رقم ${visaNumber}`, b.borderNumber);
    return {
      borderNumber: b.borderNumber,
      employeeName: 'زائر تجريبي',
      issuanceDateG: g(today),
      issuanceDateH: h(today),
      translatedEmployeeName: [b.trFirstName, b.trFatherName, b.trGrandFatherName, b.trFamilyName].join(' ').toUpperCase(),
      visaNumber,
      visaType: lookup('خروج نهائي', 'Final Exit', '3'),
    };
  },

  async 'iqama/drop'(b, req) {
    validate(b, { iqamaNumber: P.iqama });
    await simulate(b.iqamaNumber);
    logService(req, 'إبلاغ عن مقيم خرج ولم يعد', '', b.iqamaNumber);
    return { iqamaNumber: b.iqamaNumber, name: resident(b.iqamaNumber).residentName, numberOfDependents: 0 };
  },

  async 'iqama/issue'(b, req) {
    validate(b, { borderNumber: P.border, iqamaDuration: P.iqamaDuration, maritalStatus: null, passportIssueCity: null, trFamilyName: null, trFatherName: null, trFirstName: null, trGrandFatherName: null });
    await simulate(b.borderNumber);
    const iqamaNumber = '2' + String(randomInt(0, 1e9)).padStart(9, '0');
    const expiry = addMonths(todayUtc(), Number(b.iqamaDuration));
    state.iqamas.set(iqamaNumber, { expiry, version: 1 });
    logService(req, 'إصدار إقامة', `حدود ${b.borderNumber}`, iqamaNumber);
    return {
      birthDateG: '1990-01-01',
      iqamaExpiryDateG: g(expiry),
      iqamaExpiryDateH: h(expiry),
      iqamaNumber,
      nationality: lookup('الهند', 'India', '401'),
      occupation: lookup('عامل', 'Worker', '9999'),
      organizationMOINumber: '7000000000',
      organizationName: 'مؤسسة تجريبية',
      religion: lookup('مسلم', 'Muslim', '1'),
      residentName: 'مقيم جديد تجريبي',
      translatedResidentName: [b.trFirstName, b.trFatherName, b.trGrandFatherName, b.trFamilyName].join(' ').toUpperCase(),
    };
  },

  async 'iqama/issue-replacement'(b, req) {
    validate(b, { iqamaNumber: P.iqama });
    await simulate(b.iqamaNumber);
    const iq = iqamaInfo(b.iqamaNumber);
    iq.version += 1;
    logService(req, 'إصدار بدل مفقود/تالف', '', b.iqamaNumber);
    return { iqamaNumber: b.iqamaNumber, newIqamaVersionNumber: String(iq.version) };
  },

  async 'iqama/renew'(b, req) {
    validate(b, { iqamaDuration: P.iqamaDuration, iqamaNumber: P.iqama });
    await simulate(b.iqamaNumber);
    const iq = iqamaInfo(b.iqamaNumber);
    const base = iq.expiry > todayUtc() ? iq.expiry : todayUtc();
    iq.expiry = addMonths(base, Number(b.iqamaDuration));
    iq.version += 1;
    const r = resident(b.iqamaNumber);
    logService(req, 'تجديد إقامة', `${b.iqamaDuration} شهر`, b.iqamaNumber);
    return {
      iqamaNumber: b.iqamaNumber,
      newIqamaExpiryDateGre: g(iq.expiry),
      newIqamaExpiryDateHij: h(iq.expiry),
      residentName: r.residentName,
      transaltedResidentName: r.translatedResidentName,
      translatedResidentName: r.translatedResidentName,
      versionNumber: String(iq.version),
    };
  },

  async 'iqama/report-missing'(b, req) {
    validate(b, { iqamaNumber: P.iqama, missingCity: null, missingCountryCode: null, missingDate: P.date });
    await simulate(b.iqamaNumber);
    logService(req, 'إبلاغ عن فقدان إقامة', b.missingCity, b.iqamaNumber);
    return { iqamaNumber: b.iqamaNumber, name: resident(b.iqamaNumber).residentName, reportNumber: newRequestNumber() };
  },

  async 'iqama/transfer'(b, req) {
    validate(b, { iqamaNumber: P.iqama, newSponsorId: P.moi });
    await simulate(b.iqamaNumber);
    const r = resident(b.iqamaNumber);
    const iq = iqamaInfo(b.iqamaNumber);
    logService(req, 'نقل خدمات', `إلى ${b.newSponsorId}`, b.iqamaNumber);
    return {
      gender: lookup('ذكر', 'Male', '1'),
      iqamaExpiryDateG: g(iq.expiry),
      iqamaExpiryDateH: h(iq.expiry),
      iqamaNumber: b.iqamaNumber,
      nationality: lookup(r.nationality, r.nationality, '000'),
      occupation: lookup(r.occupation, r.occupation, '0000'),
      passportNumber: passportInfo(b.iqamaNumber).number,
      religion: lookup('مسلم', 'Muslim', '1'),
      residentName: r.residentName,
    };
  },

  async 'muqeem-report/print'(b, req) {
    validate(b, { iqamaNumber: P.iqama, print: null }, { language: P.lang });
    await simulate(b.iqamaNumber);
    logService(req, 'طباعة تقرير مقيم', '', b.iqamaNumber);
    // Undocumented response (no schema in the spec).
    return { reportPDF: pdfBase64(`Muqeem MOCK resident report ${b.iqamaNumber}`) };
  },

  async 'occupation/change'(b, req) {
    validate(b, { iqamaNumber: P.iqama });
    await simulate(b.iqamaNumber);
    const r = resident(b.iqamaNumber);
    const iq = iqamaInfo(b.iqamaNumber);
    const pp = passportInfo(b.iqamaNumber);
    logService(req, 'تغيير مهنة', '', b.iqamaNumber);
    return {
      iqamaExpiryDateG: g(iq.expiry),
      iqamaExpiryDateH: h(iq.expiry),
      iqamaVersionNumber: String(iq.version),
      nationality: lookup(r.nationality, r.nationality, '000'),
      newOccupationCode: '2141',
      newOccupationTitle: 'مهندس',
      oldOccupation: lookup(r.occupation, r.occupation, '0000'),
      passportExpiryDateG: g(pp.expiry),
      passportExpiryDateH: h(pp.expiry),
      passportNumber: pp.number,
      sponsorID: '7000000000',
      sponsorName: 'مؤسسة تجريبية',
    };
  },

  async 'occupation/check-mol-approval'(b) {
    validate(b, { iqamaNumber: P.iqama });
    await simulate(b.iqamaNumber);
    const r = resident(b.iqamaNumber);
    return {
      newOccupationCode: '2141',
      newOccupationTitle: 'مهندس',
      oldOccupation: lookup(r.occupation, r.occupation, '0000'),
      sponsorID: '7000000000',
      sponsorName: 'مؤسسة تجريبية',
    };
  },

  async 'report/active-residents-report'(b, req, url) {
    validate(b, { moiNumber: P.moi, withDependents: null });
    await simulate(b.moiNumber);
    const page = Math.max(0, Number(url.searchParams.get('page') ?? 0) || 0);
    const size = Math.min(2000, Math.max(1, Number(url.searchParams.get('size') ?? 20) || 20));
    const rows = state.residents.map((r) => {
      const iq = iqamaInfo(String(r.iqamaNumber));
      const pp = passportInfo(String(r.iqamaNumber));
      const row = {
        iqamaNumber: String(r.iqamaNumber),
        residentName: r.residentName,
        translatedResidentName: r.translatedResidentName,
        nationality: r.nationality,
        occupation: r.occupation,
        iqamaExpiryDateG: g(iq.expiry),
        iqamaExpiryDateH: h(iq.expiry),
        passportNumber: pp.number,
        passportExpiryDateG: g(pp.expiry),
      };
      if (b.withDependents === true) row.dependents = Array.isArray(r.dependents) ? r.dependents : [];
      return row;
    });
    void req;
    // Undocumented response (no schema in the spec): Spring Page shape.
    return {
      content: rows.slice(page * size, page * size + size),
      totalElements: rows.length,
      totalPages: Math.max(1, Math.ceil(rows.length / size)),
      number: page,
      size,
    };
  },

  async 'report/interactive-services-report'(b) {
    validate(b, { fromDate: P.date, operatorId: /^[1-2]{1}[0-9]{9}$/, toDate: P.date, user: null });
    const from = b.fromDate;
    const to = b.toDate;
    return state.log.filter((row) => row.date.slice(0, 10) >= from && row.date.slice(0, 10) <= to);
  },

  async 'translated-name/update'(b, req) {
    validate(b, { iqamaNumber: P.iqama, trFamilyName: null, trFirstName: null }, {});
    await simulate(b.iqamaNumber);
    const parts = String(resident(b.iqamaNumber).translatedResidentName || '').split(' ');
    logService(req, 'تعديل الاسم المترجم', '', b.iqamaNumber);
    return {
      iqamaNumber: b.iqamaNumber,
      trFamilyNameAfter: b.trFamilyName,
      trFamilyNameBefore: parts[parts.length - 1] || '',
      trFatherNameAfter: b.trFatherName ?? parts[1] ?? '',
      trFatherNameBefore: parts[1] || '',
      trFirstNameAfter: b.trFirstName,
      trFirstNameBefore: parts[0] || '',
      trGrandFatherNameAfter: b.trGrandFatherName ?? parts[2] ?? '',
      trGrandFatherNameBefore: parts[2] || '',
    };
  },

  async 'travel-records-report/print'(b, req) {
    validate(b, { fromDate: P.date, idNumber: /^(3|4|5|2)[0-9]{9}$/, idType: /^(1|2)$/, toDate: P.date });
    await simulate(b.idNumber);
    logService(req, 'طباعة تقرير سجل السفر', '', b.idNumber);
    return { reportPDF: pdfBase64(`Muqeem MOCK travel records ${b.idNumber}`) };
  },

  async 'update-information/extend'(b, req) {
    validate(b, { iqamaNumber: P.iqama, newPassportExpiryDate: P.date, passportNumber: P.passport });
    await simulate(b.iqamaNumber);
    const pp = passportInfo(b.iqamaNumber, b.passportNumber);
    if (pp.number !== b.passportNumber) throw business('رقم الجواز لا يطابق الجواز المسجل للمقيم');
    pp.expiry = new Date(`${b.newPassportExpiryDate}T00:00:00Z`);
    logService(req, 'تحديث معلومات (تمديد صلاحية الجواز)', `جواز …${String(b.passportNumber).slice(-4)} حتى ${b.newPassportExpiryDate}`, b.iqamaNumber);
    return true;
  },

  async 'update-information/renew'(b, req) {
    validate(b, {
      iqamaNumber: P.iqama,
      newPassportExpiryDate: P.date,
      newPassportIssueDate: P.date,
      newPassportIssueLocation: null,
      newPassportNumber: P.passport,
      passportNumber: P.passport,
    });
    await simulate(b.iqamaNumber);
    const pp = passportInfo(b.iqamaNumber, b.passportNumber);
    if (pp.number !== b.passportNumber) throw business('رقم الجواز لا يطابق الجواز المسجل للمقيم');
    pp.number = b.newPassportNumber;
    pp.expiry = new Date(`${b.newPassportExpiryDate}T00:00:00Z`);
    logService(req, 'تحديث معلومات (جواز جديد)', `جواز جديد …${String(b.newPassportNumber).slice(-4)} حتى ${b.newPassportExpiryDate}`, b.iqamaNumber);
    return true;
  },

  async 'visit-visa/extend'(b, req) {
    validate(b, { borderNumber: P.border });
    await simulate(b.borderNumber);
    const expiry = addDays(todayUtc(), 90);
    logService(req, 'تمديد تأشيرة زيارة', '', b.borderNumber);
    return { passportNumber: 'V1234567', visaExpiryDateG: g(expiry), visaExpiryDateH: h(expiry), visaNumber: newVisaNumber(), visitorName: 'زائر تجريبي' };
  },

  async 'visitor-report/print'(b, req) {
    validate(b, { borderNumber: P.border, print: null }, { language: P.lang });
    await simulate(b.borderNumber);
    logService(req, 'طباعة تقرير زائر', '', b.borderNumber);
    return { reportPDF: pdfBase64(`Muqeem MOCK visitor report ${b.borderNumber}`) };
  },
};

function feMainResident(v, status) {
  const r = resident(v.iqamaNumber);
  return {
    finalExitVisa: {
      exitBeforeG: g(v.exitBefore),
      exitBeforeH: h(v.exitBefore),
      feVisaCancellation: { iqamaNumber: v.iqamaNumber, residentName: r.residentName, visaNumber: v.visaNumber, visaStatus: status },
      issuanceDateG: g(v.issuedOn),
      issuanceDateH: h(v.issuedOn),
      visaNumber: v.visaNumber,
      visaType: 'Final Exit',
    },
    iqamaNumber: v.iqamaNumber,
    nationality: r.nationality,
    occupation: r.occupation,
    passportNumber: passportInfo(v.iqamaNumber).number,
    residentName: r.residentName,
    visaNumber: v.visaNumber,
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function fakeJwt(sub) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
  return { token: `${b64({ alg: 'HS512', typ: 'JWT' })}.${b64({ sub, auth: 'ROLE_USER', exp })}.${randomBytes(24).toString('base64url')}`, exp };
}

function checkAppHeaders(req) {
  const appId = req.headers['app-id'] ?? req.headers['app_id'];
  const appKey = req.headers['app-key'] ?? req.headers['app_key'];
  if (!appId || !appKey) throw new ApiError(403, { message: 'Authentication parameters missing (app-id / app-key)', status: 403 });
  if (appId !== APP_ID || appKey !== APP_KEY) throw new ApiError(403, { message: 'Authentication failed (invalid app-id / app-key)', status: 403 });
  if (INTEGRATOR_ID && req.headers['x-integrator-id'] !== INTEGRATOR_ID) {
    throw new ApiError(403, { message: 'Invalid or missing X-INTEGRATOR-ID', status: 403 });
  }
}

function checkBearer(req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const entry = m ? state.tokens.get(m[1].trim()) : undefined;
  if (!entry || entry.exp * 1000 <= Date.now()) throw new ApiError(401, { title: 'Unauthorized', status: 401, detail: 'Full authentication is required to access this resource' });
  req.muqeemUser = entry.user;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new ApiError(413, { message: 'Payload too large' }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function route(req, url) {
  const path = url.pathname.replace(/\/+$/, '');

  if (path === '/__mock/state' && req.method === 'GET') {
    return {
      status: 200,
      body: {
        residents: state.residents.length,
        tokens: state.tokens.size,
        visas: [...state.visas.values()].map((v) => ({ ...v, returnBefore: v.returnBefore ? g(v.returnBefore) : undefined })),
        iqamas: Object.fromEntries([...state.iqamas].map(([k, v]) => [k, { expiry: g(v.expiry), version: v.version }])),
        passports: Object.fromEntries([...state.passports].map(([k, v]) => [k, { number: v.number, expiry: g(v.expiry) }])),
        log: state.log,
        requests: state.requests,
      },
    };
  }
  if (path === '/__mock/reset' && req.method === 'POST') {
    resetState();
    return { status: 200, body: { ok: true } };
  }

  checkAppHeaders(req);

  if (path === '/api/authenticate') {
    if (req.method !== 'POST') throw new ApiError(405, { message: 'Method Not Allowed' });
    const b = await parseJson(req);
    validate(b, { password: null, username: /^[_.@A-Za-z0-9-]*$/ });
    if (String(b.username).length > 50 || String(b.password).length > 50) throw bad('قيمة غير صالحة للحقل: username/password');
    if (b.username !== USERNAME || b.password !== PASSWORD) throw new ApiError(401, { title: 'Unauthorized', status: 401, detail: 'Bad credentials' });
    const { token, exp } = fakeJwt(b.username);
    state.tokens.set(token, { exp, user: b.username });
    return { status: 200, body: { id_token: token } };
  }

  const lookupMatch = path.match(/^\/api\/lookups\/(cities|countries|marital-statuses)$/);
  if (lookupMatch) {
    if (req.method !== 'GET') throw new ApiError(405, { message: 'Method Not Allowed' });
    // The spec lists no bearer requirement for lookups: accepted with or without a token.
    const data = { cities: CITIES, countries: COUNTRIES, 'marital-statuses': MARITAL_STATUSES }[lookupMatch[1]];
    return { status: 200, body: data };
  }

  const v1 = path.match(/^\/api\/v1\/(.+)$/);
  if (v1 && Object.prototype.hasOwnProperty.call(V1, v1[1])) {
    if (req.method !== 'POST') throw new ApiError(405, { message: 'Method Not Allowed' });
    checkBearer(req);
    const b = await parseJson(req);
    state.requests.push({ at: new Date().toISOString(), path: v1[1], id: String(b?.iqamaNumber ?? b?.borderNumber ?? b?.idNumber ?? '') });
    return { status: 200, body: await V1[v1[1]](b, req, url) };
  }

  throw new ApiError(404, { message: `No mock for ${req.method} ${path}`, status: 404 });
}

async function parseJson(req) {
  const text = await readBody(req);
  if (!text.trim()) throw bad('جسم الطلب مطلوب');
  try {
    return JSON.parse(text);
  } catch {
    throw bad('صيغة JSON غير صحيحة');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  let status = 500;
  let body;
  try {
    ({ status, body } = await route(req, url));
  } catch (err) {
    if (err instanceof ApiError) {
      status = err.status;
      body = err.body;
    } else {
      console.error(err);
      status = 500;
      body = { message: 'Internal Server Error', status: 500 };
    }
  }
  const line = `${new Date().toISOString()} ${req.method} ${url.pathname} -> ${status}`;
  // (req.destroyed is true once the body was read: only the socket tells whether the client left.)
  if (res.writableEnded || !res.socket || res.socket.destroyed) {
    console.log(`${line} (client gone)`);
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json;charset=UTF-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
  console.log(line);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Muqeem MOCK listening on http://127.0.0.1:${PORT} (app-id=${APP_ID}, user=${USERNAME}${INTEGRATOR_ID ? ', integrator mode' : ''})`);
  console.log(`Residents: ${state.residents.length}${process.env.MUQEEM_MOCK_FIXTURES ? ` from ${process.env.MUQEEM_MOCK_FIXTURES}` : ' (default list)'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
