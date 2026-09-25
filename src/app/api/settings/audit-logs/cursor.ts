// Keyset ("cursor") pagination for the audit log: newest first, ordered by (createdAt, id).
// Unlike skip/offset, rows inserted while the user pages through the list neither shift nor
// duplicate the next page. Pure helpers (no I/O) so they can be unit tested.

export interface AuditCursor {
  createdAt: Date;
  id: string;
}

const CURSOR_RE = /^(\d{1,15})_([A-Za-z0-9-]{1,64})$/;

/** Opaque cursor string for the last row of a page: "<epoch ms>_<id>". */
export function encodeAuditCursor(row: { createdAt: Date | string; id: string }): string {
  const ms = new Date(row.createdAt).getTime();
  return `${ms}_${row.id}`;
}

/** Parses a cursor from the query string; null when missing or malformed. */
export function parseAuditCursor(raw: string | null | undefined): AuditCursor | null {
  if (!raw) return null;
  const m = CURSOR_RE.exec(raw.trim());
  if (!m) return null;
  const createdAt = new Date(Number(m[1]));
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: m[2] };
}

/** Rows strictly after the cursor in (createdAt DESC, id DESC) order. */
export function auditCursorWhere(cursor: AuditCursor) {
  return {
    OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
  };
}

/** Stable ordering matching auditCursorWhere. */
export const AUDIT_ORDER_BY = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

/**
 * Given `take + 1` fetched rows, returns the page and the cursor for the next one
 * (null when this is the last page).
 */
export function paginateAuditRows<T extends { createdAt: Date | string; id: string }>(
  rows: readonly T[],
  take: number,
): { page: T[]; nextCursor: string | null } {
  const page = rows.slice(0, take);
  const nextCursor = rows.length > take && page.length ? encodeAuditCursor(page[page.length - 1]) : null;
  return { page, nextCursor };
}
