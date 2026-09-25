// DEPRECATED legacy diagnostic script (see ops/legacy/README.md). Reads DATABASE_URL from the environment.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.rolePermission.findMany().then(res => {
  console.dir(res, {depth: null});
}).finally(() => prisma.$disconnect());
