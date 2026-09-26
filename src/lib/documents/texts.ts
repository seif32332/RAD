// Company wording per document type (owner decision 2026-09-26): an opening and a closing paragraph
// around the fixed legal body of each template. Append-only rows; the latest per company, type and
// slot is in force (an empty text = removed). The text in force goes into the snapshot, so an
// approval covers it and an issued document keeps it.
import 'server-only';
import type { Prisma } from '@prisma/client';

export type TextSlot = 'OPENING' | 'CLOSING';

export interface DocumentTexts {
  openingAr: string | null;
  openingEn: string | null;
  closingAr: string | null;
  closingEn: string | null;
}

/** Texts in force for a company and type; null when none is set. */
export async function loadDocumentTexts(db: Prisma.TransactionClient, companyId: string, typeKey: string): Promise<DocumentTexts | null> {
  const rows = await db.documentTextOverride.findMany({
    where: { companyId, typeKey },
    orderBy: { createdAt: 'desc' },
    select: { slot: true, textAr: true, textEn: true },
    take: 50,
  });
  const latest = (slot: TextSlot) => rows.find((r) => r.slot === slot) ?? null;
  const o = latest('OPENING');
  const c = latest('CLOSING');
  const t: DocumentTexts = { openingAr: o?.textAr || null, openingEn: o?.textEn || null, closingAr: c?.textAr || null, closingEn: c?.textEn || null };
  return t.openingAr || t.closingAr ? t : null;
}
