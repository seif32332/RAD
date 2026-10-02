import { PrismaClient } from '@prisma/client';
import { moneyGatewayExtension } from '@/modules/platform';

// One PrismaClient per process. NEVER call `new PrismaClient()` anywhere else.
//
// The exported (and cached) client is the one EXTENDED with money.gateway (ARCH-004, BR-PAY-018): a
// write to a money table outside a registered gateway operation is refused (fail closed). The bare
// client is never exported nor cached, so every scoped client (iam) and every transaction inherits the
// extension. The extension adds no model method, so the client keeps the PrismaClient type.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const base = new PrismaClient({
    // Query logging leaks PII (IDs, IBANs, salaries) into logs, so it is dev-only.
    log:
      process.env.PRISMA_LOG_QUERIES === 'true'
        ? ['query', 'warn', 'error']
        : process.env.NODE_ENV === 'production'
          ? ['error']
          : ['warn', 'error'],
  });
  return base.$extends(moneyGatewayExtension) as unknown as PrismaClient;
}

export const prisma = globalForPrisma.prisma ?? createClient();

// Cache on globalThis in every environment so hot reload and multiple route
// bundles share a single connection pool.
globalForPrisma.prisma = prisma;
