// Display formatting for the render model (ADR DOC-01): the renderer only lays out these strings.
//
// Month names come from fixed tables here, not from ICU, so a Node / ICU upgrade can never change
// the text of a document re-rendered from its snapshot (DOC-07). ICU is used only for the
// Umm al-Qura calendar conversion itself (numbers).

export type Numerals = 'latn' | 'arab';

const GREGORIAN_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const GREGORIAN_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const HIJRI_AR = ['محرم', 'صفر', 'ربيع الأول', 'ربيع الآخر', 'جمادى الأولى', 'جمادى الآخرة', 'رجب', 'شعبان', 'رمضان', 'شوال', 'ذو القعدة', 'ذو الحجة'];
const HIJRI_EN = ["Muharram", 'Safar', "Rabi' al-Awwal", "Rabi' al-Thani", 'Jumada al-Ula', 'Jumada al-Akhirah', 'Rajab', "Sha'ban", 'Ramadan', 'Shawwal', "Dhu al-Qi'dah", 'Dhu al-Hijjah'];

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';

/** Latin digits -> Arabic-Indic digits when requested. */
export function digits(s: string, numerals: Numerals): string {
  return numerals === 'arab' ? s.replace(/[0-9]/g, (d) => ARABIC_INDIC[Number(d)]) : s;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIsoDate(iso: string): { y: number; m: number; d: number } {
  const m = ISO_DATE.exec(iso);
  if (!m) throw new Error(`not an ISO date: ${iso}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** "26 سبتمبر 2026" / "26 September 2026" (the date as given, no time zone shift). */
export function formatGregorian(iso: string, lang: 'ar' | 'en', numerals: Numerals = 'latn'): string {
  const { y, m, d } = parseIsoDate(iso);
  if (lang === 'en') return `${d} ${GREGORIAN_EN[m - 1]} ${y}`;
  return digits(`${d} ${GREGORIAN_AR[m - 1]} ${y}`, numerals);
}

/** Umm al-Qura date of a Gregorian calendar date, as numbers. */
export function toHijri(iso: string): { y: number; m: number; d: number } {
  parseIsoDate(iso);
  // Noon in Riyadh: the calendar day cannot shift whatever the server's time zone.
  const parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
    year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'Asia/Riyadh',
  }).formatToParts(new Date(`${iso}T12:00:00+03:00`));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const out = { y: get('year'), m: get('month'), d: get('day') };
  if (![out.y, out.m, out.d].every(Number.isInteger) || out.m < 1 || out.m > 12) throw new Error(`Hijri conversion failed for ${iso}`);
  return out;
}

/** "15 ربيع الآخر 1448 هـ" / "15 Rabi' al-Thani 1448 AH". */
export function formatHijri(iso: string, lang: 'ar' | 'en', numerals: Numerals = 'latn'): string {
  const { y, m, d } = toHijri(iso);
  if (lang === 'en') return `${d} ${HIJRI_EN[m - 1]} ${y} AH`;
  return digits(`${d} ${HIJRI_AR[m - 1]} ${y} هـ`, numerals);
}

/** "15,000.00" / "١٥٬٠٠٠٫٠٠" from a decimal string with two fraction digits. */
export function formatAmount(amount: string, numerals: Numerals = 'latn'): string {
  if (!/^-?\d+\.\d{2}$/.test(amount)) throw new Error(`not a two-decimal amount: ${amount}`);
  const negative = amount.startsWith('-');
  const [int, frac] = amount.replace('-', '').split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const latin = `${negative ? '-' : ''}${grouped}.${frac}`;
  if (numerals === 'latn') return latin;
  // Arabic thousands separator U+066C, decimal separator U+066B.
  return digits(latin, 'arab').replace(/,/g, '٬').replace('.', '٫');
}

/** Page-number pattern for the template (Typst numbering). */
export const pageNumbering = (numerals: Numerals) => (numerals === 'arab' ? '١' : '1');
