// Local Arabic -> Latin transliteration used to pre-fill English names in forms
// (companies, administrations, branches, departments, employees). Pure and client-safe:
// no network, no third-party translation service. The result is only a suggestion the user can edit.

const LETTERS: Readonly<Record<string, string>> = {
  'ا': 'A', 'أ': 'A', 'إ': 'E', 'آ': 'A', 'ب': 'B', 'ت': 'T', 'ث': 'Th', 'ج': 'J',
  'ح': 'H', 'خ': 'Kh', 'د': 'D', 'ذ': 'Dh', 'ر': 'R', 'ز': 'Z', 'س': 'S', 'ش': 'Sh',
  'ص': 'S', 'ض': 'D', 'ط': 'T', 'ظ': 'Z', 'ع': 'A', 'غ': 'Gh', 'ف': 'F', 'ق': 'Q',
  'ك': 'K', 'ل': 'L', 'م': 'M', 'ن': 'N', 'ه': 'H', 'و': 'W', 'ي': 'Y', 'ى': 'A',
  'ة': 'A', 'ئ': 'E', 'ء': 'A', 'ؤ': 'O',
};

/** Arabic diacritics (tashkeel) and tatweel: dropped before transliteration. */
const DIACRITICS = /[ً-ْـ]/g;

/** Words with an established English form in organization names. */
const ORG_WORDS: Readonly<Record<string, string>> = {
  'شركة': 'Company', 'مؤسسة': 'Establishment', 'مجموعة': 'Group', 'مصنع': 'Factory',
  'فرع': 'Branch', 'ادارة': 'Administration', 'إدارة': 'Administration', 'الإدارة': 'Administration', 'الادارة': 'Administration',
  'قسم': 'Department', 'المالية': 'Finance', 'الموارد': 'Resources', 'البشرية': 'Human',
  'تقنية': 'Tech', 'المعلومات': 'Information', 'التسويق': 'Marketing',
  'المبيعات': 'Sales', 'العمليات': 'Operations', 'القانونية': 'Legal',
  'البيان': 'AlBayan', 'للتقنية': 'For Tech', 'لتقنية': 'For Tech', 'التجارية': 'Trading',
  'للتجارة': 'For Trading', 'الطبية': 'Medical', 'للمقاولات': 'For Contracting',
  'المقاولات': 'Contracting',
};

/** Common first names with an established English spelling. */
const PERSON_NAMES: Readonly<Record<string, string>> = {
  'عبد': 'Abdul', 'عبدال': 'Abdul', 'عبدالرحمن': 'Abdulrahman', 'عبدالله': 'Abdullah', 'عبدالعزيز': 'Abdulaziz',
  'محمد': 'Mohammed', 'احمد': 'Ahmed', 'أحمد': 'Ahmed', 'خالد': 'Khalid', 'عمر': 'Omar',
  'علي': 'Ali', 'حسن': 'Hassan', 'حسين': 'Hussain', 'فهد': 'Fahad', 'سعود': 'Saud',
  'سعد': 'Saad', 'سالم': 'Salem', 'صالح': 'Saleh', 'طارق': 'Tariq', 'زياد': 'Ziyad', 'وليد': 'Waleed',
};

function capitalizeWords(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

function transliterate(text: string, dictionary: Readonly<Record<string, string>>, abdulPrefix: boolean): string {
  if (!text) return '';
  const words = text
    .replace(DIACRITICS, '')
    .split(/\s+/)
    .map((word) => {
      if (!word) return '';
      if (dictionary[word]) return dictionary[word];
      let prefix = '';
      let w = word;
      if (w.startsWith('ال') && w.length > 2) {
        prefix = 'Al';
        w = w.slice(2);
      } else if (abdulPrefix && w.startsWith('عبد') && w.length > 3) {
        prefix = 'Abdul';
        w = w.slice(3);
        if (w.startsWith('ال') && w.length > 2) w = w.slice(2); // عبدالكريم -> Abdulkrym, not Abdulalkrym
      }
      let en = '';
      for (const ch of w) en += LETTERS[ch] ?? ch; // latin letters / digits / symbols are kept
      return (prefix + en).toLowerCase();
    });
  return capitalizeWords(words.join(' '));
}

/** Organization names: "شركة البيان للتقنية" -> "Company AlBayan For Tech". */
export function transliterateArabicToEnglish(text: string): string {
  return transliterate(text, ORG_WORDS, false);
}

/** Person names: "عبدالله العمري" -> "Abdullah Alamri". */
export function transliteratePersonName(text: string): string {
  return transliterate(text, PERSON_NAMES, true);
}
