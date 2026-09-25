// Contract test of the real client against scripts/muqeem-mock.mjs.
// Runs only when the mock is listening (node scripts/muqeem-mock.mjs); skipped otherwise.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const companyFindUnique = vi.fn();
vi.mock('@/lib/prisma', () => ({ prisma: { company: { findUnique: (...a: unknown[]) => companyFindUnique(...a) } } }));

import { encryptField } from '@/lib/crypto';
import { clearMuqeemCaches, createMuqeemClient } from '@/lib/muqeem/client';
import { MuqeemError } from '@/lib/muqeem/errors';
import { toHijriDateString } from '@/lib/muqeem/hijri';
import { normalizeActiveResidents } from '@/lib/muqeem/types';

const MOCK_URL = process.env.MUQEEM_MOCK_URL || 'http://127.0.0.1:4010';

async function mockIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${MOCK_URL}/__mock/state`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}
const up = await mockIsUp();

const ENV = {
  MUQEEM_ENABLED: 'true',
  MUQEEM_BASE_URL: MOCK_URL,
  MUQEEM_APP_ID: 'local-mock-app',
  MUQEEM_APP_KEY: 'local-mock-key',
  MUQEEM_TIMEOUT_MS: '1500',
};
const saved: Record<string, string | undefined> = {};

describe.skipIf(!up)('client <-> muqeem mock contract', () => {
  beforeAll(() => {
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    clearMuqeemCaches();
    companyFindUnique.mockResolvedValue({
      id: 'mq-contract',
      moiNumber: '7001234567',
      muqeemPlatform: { id: 'p', username: 'mock-user', password: encryptField('mock-pass') },
    });
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    clearMuqeemCaches();
  });

  it('authenticates, reads lookups and the active residents report', async () => {
    const client = await createMuqeemClient({ companyId: 'mq-contract' });
    await client.authenticate({ force: true });
    expect((await client.getCountries()).length).toBeGreaterThan(0);
    const residents = normalizeActiveResidents(await client.getActiveResidentsReport({ withDependents: false }));
    expect(residents.length).toBeGreaterThan(0);
    expect(residents[0].iqamaNumber).toMatch(/^2\d{9}$/);
    expect(residents[0].iqamaExpiry).toBeInstanceOf(Date);
  });

  it('issues, reprints, extends and cancels an exit/re-entry visa', async () => {
    const client = await createMuqeemClient({ companyId: 'mq-contract' });
    const iqama = `24${String(Date.now()).slice(-8)}`.replace(/0000$|9999$|5003$/, '1111');
    const issued = await client.issueExitReentry({ iqamaNumber: iqama, visaType: 1, visaDuration: 30 });
    expect(issued.visaNumber).toMatch(/^\d+$/);
    expect(Buffer.from(issued.ervisaPDF ?? '', 'base64').toString('latin1').startsWith('%PDF-')).toBe(true);
    const reprint = await client.reprintExitReentry({ iqamaNumber: iqama, visaNumber: issued.visaNumber });
    expect(reprint.ervisaPDF).toBeTruthy();
    const newReturn = toHijriDateString(new Date(Date.now() + 60 * 86_400_000));
    const extended = await client.extendExitReentry({ iqamaNumber: iqama, visaNumber: issued.visaNumber, visaDuration: 30, returnBefore: newReturn });
    expect(extended.returnBeforeAfterExtensionH).toBe(newReturn);
    const cancelled = await client.cancelExitReentry({ iqamaNumber: iqama, erVisaNumber: issued.visaNumber });
    expect(cancelled.visaStatus).toBe('Cancelled');
  });

  it("'0000' -> REJECTED with the Arabic message", async () => {
    const client = await createMuqeemClient({ companyId: 'mq-contract' });
    await expect(client.renewIqama({ iqamaNumber: '2400000000', iqamaDuration: '12' })).rejects.toMatchObject({
      kind: 'REJECTED',
      upstreamMessage: 'الإقامة غير مؤهلة للخدمة',
    });
  });

  it("'9999' -> the mock hangs past the timeout -> UNKNOWN_OUTCOME", async () => {
    const client = await createMuqeemClient({ companyId: 'mq-contract' });
    const err = await client.renewIqama({ iqamaNumber: '2400009999', iqamaDuration: '12' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MuqeemError);
    expect((err as MuqeemError).kind).toBe('UNKNOWN_OUTCOME');
  });

  it('wrong app key -> AUTH', async () => {
    process.env.MUQEEM_APP_KEY = 'wrong-key';
    try {
      clearMuqeemCaches();
      const client = await createMuqeemClient({ companyId: 'mq-contract' });
      await expect(client.authenticate()).rejects.toMatchObject({ kind: 'AUTH' });
    } finally {
      process.env.MUQEEM_APP_KEY = ENV.MUQEEM_APP_KEY;
      clearMuqeemCaches();
    }
  });
});
