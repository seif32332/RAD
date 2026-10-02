import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JOB_NAMES } from '@/jobs/registry';

// ARCH-018 / master plan P0-03: every scheduled job in JOB_NAMES (src/jobs/registry.ts) has a timer in ops/systemd
// (installed and enabled by ops/jobs-setup.sh), and ops/run-jobs.sh accepts exactly the same names.
// A job added to JOB_NAMES without a timer never runs in production.

const ROOT = join(__dirname, '..', '..', '..');
const SYSTEMD = join(ROOT, 'ops', 'systemd');

function timerJobs(): string[] {
  return readdirSync(SYSTEMD)
    .filter((f) => /^radeef-jobs@[a-z-]+\.timer$/.test(f))
    .map((f) => f.slice('radeef-jobs@'.length, -'.timer'.length))
    .sort();
}

function runJobsPattern(): string[] {
  const src = readFileSync(join(ROOT, 'ops', 'run-jobs.sh'), 'utf8');
  const m = src.match(/^JOB_RE='\^\(([a-z|-]+)\)\$'$/m);
  if (!m) throw new Error('JOB_RE not found in ops/run-jobs.sh');
  return m[1].split('|').sort();
}

describe('background job timers (ARCH-018)', () => {
  const jobs = [...JOB_NAMES].sort();

  it('every job in JOB_NAMES has exactly one timer, and no timer runs an unknown job', () => {
    expect(timerJobs()).toEqual(jobs);
  });

  it('ops/run-jobs.sh accepts exactly JOB_NAMES', () => {
    expect(runJobsPattern()).toEqual(jobs);
  });

  it('the template service exists and every timer is persistent, in Riyadh time, with a random delay', () => {
    expect(readFileSync(join(SYSTEMD, 'radeef-jobs@.service'), 'utf8')).toMatch(/^ExecStart=\/opt\/radeef\/src\/ops\/run-jobs\.sh %i$/m);
    for (const job of jobs) {
      const unit = readFileSync(join(SYSTEMD, `radeef-jobs@${job}.timer`), 'utf8');
      expect(unit, job).toMatch(/^OnCalendar=.+ Asia\/Riyadh$/m);
      expect(unit, job).toMatch(/^RandomizedDelaySec=\d+min$/m);
      expect(unit, job).toMatch(/^Persistent=true$/m);
      expect(unit, job).toMatch(/^WantedBy=timers\.target$/m);
    }
  });
});
