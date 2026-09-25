#!/usr/bin/env node
// Read-only data-quality report (DEC-002 / DEC-003): employees whose stored nationality does not
// agree with the shape of their ID number.
//
//   node scripts/report-nationality-review.mjs > nationality-review.csv
//   node scripts/report-nationality-review.mjs --include-terminated
//
// Uses DATABASE_URL (same as the app). Writes CSV (UTF-8 with BOM, for Excel) to stdout and a
// short summary to stderr. It NEVER writes to the database.
//
// HEURISTIC, NOT A RULE: Saudi national ID numbers are commonly observed to start with 1 and
// iqama (resident) numbers with 2. A row in this report is a prompt for HR to check the
// employee's documents, not proof that the stored nationality is wrong. Only 10-digit numbers
// are judged; other formats (passport, border number, legacy values) are listed separately as
// "unrecognized" so they can be reviewed too.
//
// The Saudi aliases below mirror src/lib/employee-shared.ts (normalizeNationality): keep in sync.
import { PrismaClient } from '@prisma/client';

const SAUDI_ALIASES = new Set(['saudi', 'saudi arabia', 'saudi arabian', 'sa', 'ksa', 'سعودي', 'سعودى', 'سعودية', 'السعودية']);

function isSaudi(nationality) {
  if (typeof nationality !== 'string') return false;
  return SAUDI_ALIASES.has(nationality.trim().replace(/\s+/g, ' ').toLowerCase());
}

function normalizeId(v) {
  return String(v ?? '')
    .replace(/[‎‏\s]/g, '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** Reason code + Arabic text for a mismatch, or null when the row looks consistent. */
function classify(emp) {
  const saudi = isSaudi(emp.nationality);
  const id = normalizeId(emp.iqamaOrIdNumber);
  if (!emp.nationality || !emp.nationality.trim()) {
    return { code: 'NATIONALITY_BLANK', text: 'الجنسية فارغة' };
  }
  if (!/^\d{10}$/.test(id)) {
    return { code: 'ID_UNRECOGNIZED', text: 'رقم الهوية ليس 10 أرقام — لا يمكن الحكم تلقائياً' };
  }
  if (saudi && !id.startsWith('1')) return { code: 'SAUDI_ID_NOT_1', text: 'مسجل سعودي ورقم الهوية لا يبدأ بـ 1' };
  if (!saudi && id.startsWith('1')) return { code: 'NON_SAUDI_ID_1', text: 'مسجل غير سعودي ورقم الهوية يبدأ بـ 1' };
  return null;
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  // Neutralize spreadsheet formulas and quote every cell.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

async function main() {
  const includeTerminated = process.argv.includes('--include-terminated');
  const prisma = new PrismaClient();
  try {
    const employees = await prisma.employee.findMany({
      where: includeTerminated ? {} : { isTerminated: false },
      select: {
        employeeId: true,
        firstNameArabic: true,
        lastNameArabic: true,
        nationality: true,
        iqamaOrIdNumber: true,
        idType: true,
        gosiRegime: true,
        isTerminated: true,
        legalCompany: { select: { nameArabic: true } },
      },
      orderBy: { employeeId: 'asc' },
    });

    const header = ['employee_code', 'name', 'stored_nationality', 'id_number', 'id_type', 'gosi_regime', 'terminated', 'legal_company', 'reason_code', 'reason'];
    const lines = [header.map(csvCell).join(',')];
    const counts = {};
    for (const emp of employees) {
      const hit = classify(emp);
      if (!hit) continue;
      counts[hit.code] = (counts[hit.code] ?? 0) + 1;
      lines.push(
        [
          emp.employeeId,
          `${emp.firstNameArabic} ${emp.lastNameArabic ?? ''}`.trim(),
          emp.nationality,
          emp.iqamaOrIdNumber,
          emp.idType ?? '',
          emp.gosiRegime,
          emp.isTerminated ? 'yes' : 'no',
          emp.legalCompany?.nameArabic ?? '',
          hit.code,
          hit.text,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    process.stdout.write('﻿' + lines.join('\r\n') + '\r\n');
    process.stderr.write(
      `[report-nationality-review] scanned ${employees.length} employees${includeTerminated ? ' (incl. terminated)' : ' (active only)'}; ` +
        `flagged ${lines.length - 1}: ${JSON.stringify(counts)}\n` +
        '[report-nationality-review] heuristic only (national ID ~ starts with 1, iqama ~ starts with 2): verify against documents.\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`[report-nationality-review] failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
