import { describe, expect, it } from 'vitest';
import {
  decideFileAccess,
  fileUrlCandidates,
  registryMimeType,
  storedNameFromSegments,
  storedNameFromUrl,
} from '@/lib/storage';
import {
  auditCursorWhere,
  encodeAuditCursor,
  paginateAuditRows,
  parseAuditCursor,
} from '@/app/api/settings/audit-logs/cursor';

describe('storedNameFromUrl', () => {
  it('extracts the name from new and legacy URLs', () => {
    expect(storedNameFromUrl('/api/files/abc.pdf')).toBe('abc.pdf');
    expect(storedNameFromUrl('/uploads/old-cv.pdf')).toBe('old-cv.pdf');
    expect(storedNameFromUrl('/uploads/sub/x.png')).toBe('sub/x.png');
  });
  it('accepts absolute URLs and drops query/hash', () => {
    expect(storedNameFromUrl('https://hr.example.com/api/files/a.pdf?download=1#p2')).toBe('a.pdf');
  });
  it('decodes percent escapes', () => {
    expect(storedNameFromUrl('/uploads/%D8%B9%D9%82%D8%AF.pdf')).toBe('عقد.pdf');
  });
  it('rejects foreign or unsafe URLs', () => {
    expect(storedNameFromUrl(null)).toBeNull();
    expect(storedNameFromUrl('')).toBeNull();
    expect(storedNameFromUrl('https://maps.google.com/x')).toBeNull();
    expect(storedNameFromUrl('/api/files/')).toBeNull();
    expect(storedNameFromUrl('/api/files/../secret')).toBeNull();
    expect(storedNameFromUrl('/api/files/%2e%2e/secret')).toBeNull();
    expect(storedNameFromUrl('/api/files/.env')).toBeNull();
    expect(storedNameFromUrl('/api/files/a%2Fb')).toBeNull();
    expect(storedNameFromUrl('/api/files/%E0%A4%A')).toBeNull();
    expect(storedNameFromUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('storedNameFromSegments', () => {
  it('joins safe segments', () => {
    expect(storedNameFromSegments(['a.pdf'])).toBe('a.pdf');
    expect(storedNameFromSegments(['d', 'a.pdf'])).toBe('d/a.pdf');
  });
  it('rejects traversal, hidden files and too deep paths', () => {
    expect(storedNameFromSegments([])).toBeNull();
    expect(storedNameFromSegments(['..', 'a'])).toBeNull();
    expect(storedNameFromSegments(['.git'])).toBeNull();
    expect(storedNameFromSegments(['a\\b'])).toBeNull();
    expect(storedNameFromSegments(['c:x'])).toBeNull();
    expect(storedNameFromSegments(['a', 'b', 'c', 'd', 'e', 'f'])).toBeNull();
  });
});

describe('fileUrlCandidates', () => {
  it('lists both prefixes', () => {
    expect(fileUrlCandidates('a.pdf')).toEqual(['/api/files/a.pdf', '/uploads/a.pdf']);
  });
  it('adds percent-encoded spellings for non-ASCII names', () => {
    const c = fileUrlCandidates('عقد.pdf');
    expect(c).toContain('/uploads/عقد.pdf');
    expect(c).toContain('/uploads/%D8%B9%D9%82%D8%AF.pdf');
    expect(c).toHaveLength(4);
  });
  it('round-trips with storedNameFromUrl', () => {
    for (const url of fileUrlCandidates('d/ملف 1.pdf')) expect(storedNameFromUrl(url)).toBe('d/ملف 1.pdf');
  });
});

describe('decideFileAccess', () => {
  const emp = { id: 'u1', employeeId: 'e1', isStaff: false };
  it('staff may read anything, including unregistered legacy files', () => {
    expect(decideFileAccess({ id: 'x', employeeId: null, isStaff: true }, null)).toBe('allow');
    expect(decideFileAccess({ id: 'x', employeeId: null, isStaff: true }, { uploadedById: 'y', employeeId: 'z' })).toBe('allow');
  });
  it('legacy files without a registry row are staff-only', () => {
    expect(decideFileAccess(emp, null)).toBe('deny');
  });
  it('uploader and owning employee are allowed', () => {
    expect(decideFileAccess(emp, { uploadedById: 'u1', employeeId: null })).toBe('allow');
    expect(decideFileAccess(emp, { uploadedById: 'hr', employeeId: 'e1' })).toBe('allow');
  });
  it("someone else's file needs a reference from the employee's own records", () => {
    expect(decideFileAccess(emp, { uploadedById: 'u2', employeeId: 'e2' })).toBe('check-references');
    expect(decideFileAccess(emp, { uploadedById: null, employeeId: null })).toBe('check-references');
  });
  it('a non-staff user without an employee file cannot use references', () => {
    const noEmp = { id: 'u9', employeeId: null, isStaff: false };
    expect(decideFileAccess(noEmp, { uploadedById: 'u2', employeeId: null })).toBe('deny');
    // null employeeId on both sides must never match
    expect(decideFileAccess(noEmp, { uploadedById: null, employeeId: null })).toBe('deny');
  });
});

describe('registryMimeType', () => {
  it('strips charset parameters and falls back to octet-stream', () => {
    expect(registryMimeType('a.pdf')).toBe('application/pdf');
    expect(registryMimeType('a.txt')).toBe('text/plain');
    expect(registryMimeType('a.bin')).toBe('application/octet-stream');
  });
});

describe('audit log cursor', () => {
  const row = { createdAt: new Date('2026-09-01T10:00:00.123Z'), id: '6f1c2d3e-aaaa-4bbb-8ccc-123456789abc' };
  it('encodes and parses round-trip', () => {
    const c = encodeAuditCursor(row);
    expect(c).toBe(`${row.createdAt.getTime()}_${row.id}`);
    expect(parseAuditCursor(c)).toEqual(row);
  });
  it('rejects malformed cursors', () => {
    for (const bad of ['', 'abc', '123', '_id', '12_ id', '1_a;drop', `${'9'.repeat(16)}_x`]) {
      expect(parseAuditCursor(bad)).toBeNull();
    }
    expect(parseAuditCursor(null)).toBeNull();
  });
  it('builds a strict (createdAt, id) keyset condition', () => {
    expect(auditCursorWhere(row)).toEqual({
      OR: [{ createdAt: { lt: row.createdAt } }, { createdAt: row.createdAt, id: { lt: row.id } }],
    });
  });
  it('paginates take+1 rows', () => {
    const rows = [1, 2, 3].map((i) => ({ id: `id-${i}`, createdAt: new Date(1000 - i) }));
    const full = paginateAuditRows(rows, 2);
    expect(full.page.map((r) => r.id)).toEqual(['id-1', 'id-2']);
    expect(full.nextCursor).toBe(`998_id-2`);
    const last = paginateAuditRows(rows.slice(0, 2), 2);
    expect(last.nextCursor).toBeNull();
    expect(paginateAuditRows([], 5)).toEqual({ page: [], nextCursor: null });
  });
});
