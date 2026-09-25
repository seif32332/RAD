import { PrismaClient } from '@prisma/client';

// One PrismaClient per process. NEVER call `new PrismaClient()` anywhere else.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  return new PrismaClient({
    // Query logging leaks PII (IDs, IBANs, salaries) into logs, so it is dev-only.
    log:
      process.env.PRISMA_LOG_QUERIES === 'true'
        ? ['query', 'warn', 'error']
        : process.env.NODE_ENV === 'production'
          ? ['error']
          : ['warn', 'error'],
  });
}

export const prisma = globalForPrisma.prisma ?? createClient();

// Cache on globalThis in every environment so hot reload and multiple route
// bundles share a single connection pool.
globalForPrisma.prisma = prisma;
