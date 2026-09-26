import 'server-only';
import { getClientIp, type AuthUser } from '@/lib/auth';
import type { Actor } from '@/lib/documents/service';

/**
 * The acting user of a documents request. A leaver's documents-only session acts as himself only:
 * no role, so a former HR / payroll employee keeps no staff power over anyone's documents.
 */
export const actorFrom = (user: AuthUser, req: Request): Actor => ({
  userId: user.id,
  role: user.documentsOnly ? null : user.role,
  employeeId: user.employeeId,
  ip: getClientIp(req),
});
