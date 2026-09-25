// Client/server-safe helper (no imports) shared by the insurance pages and API routes.

/**
 * True for an attachment reference that can be opened: an uploaded file (/api/files/<name>),
 * a legacy /uploads/<name> path, or an absolute http(s) link. Old records created by the
 * previous "new policy" page contain only a bare file name ("benefits.pdf"): the file was never
 * uploaded, so those must be re-uploaded.
 */
export function isStoredFileUrl(v: string | null | undefined): v is string {
  if (!v) return false;
  return /^\/api\/files\/[^/]/.test(v) || /^\/uploads\/[^/]/.test(v) || /^https?:\/\/\S+$/i.test(v);
}
