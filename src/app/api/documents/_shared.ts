import 'server-only';
import { getClientIp, type AuthUser } from '@/lib/auth';
import type { Actor } from '@/lib/documents/service';

export const actorFrom = (user: AuthUser, req: Request): Actor => ({
  userId: user.id,
  role: user.role,
  employeeId: user.employeeId,
  ip: getClientIp(req),
});
