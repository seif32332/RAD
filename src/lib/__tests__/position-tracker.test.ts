import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POSITION_ERROR, PositionTracker, type PositionState } from '@/lib/position-tracker';

/** Minimal navigator.geolocation double: the test pushes readings / errors into the active watch. */
function fakeGeolocation() {
  let success: ((p: { coords: { latitude: number; longitude: number; accuracy: number } }) => void) | null = null;
  let failure: ((e: { code: number }) => void) | null = null;
  const geo = {
    watchPosition: vi.fn((ok: typeof success, ko: typeof failure) => {
      success = ok;
      failure = ko;
      return 7;
    }),
    clearWatch: vi.fn(() => {
      success = null;
      failure = null;
    }),
  };
  return {
    geo,
    fix: (accuracy: number, latitude = 24.7, longitude = 46.7) => success?.({ coords: { latitude, longitude, accuracy } }),
    fail: (code: number) => failure?.({ code }),
  };
}

describe('PositionTracker', () => {
  let g: ReturnType<typeof fakeGeolocation>;

  beforeEach(() => {
    vi.useFakeTimers();
    g = fakeGeolocation();
    vi.stubGlobal('navigator', { geolocation: g.geo });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves as soon as a reading is precise enough', async () => {
    const t = new PositionTracker();
    t.start();
    const p = t.wait(100, 15_000);
    g.fix(900);
    g.fix(35, 24.71);
    await expect(p).resolves.toMatchObject({ accuracy: 35, latitude: 24.71 });
    expect(g.geo.watchPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), expect.objectContaining({ enableHighAccuracy: true, maximumAge: 0 }));
  });

  it('waits for a better fix, then gives the best one it has', async () => {
    const t = new PositionTracker();
    t.start();
    const p = t.wait(100, 15_000);
    g.fix(900);
    g.fix(350);
    g.fix(600);
    vi.advanceTimersByTime(15_000);
    await expect(p).resolves.toMatchObject({ accuracy: 350 });
  });

  it('uses a reading that is already there without waiting', async () => {
    const t = new PositionTracker();
    t.start();
    g.fix(20);
    await expect(t.wait(100, 15_000)).resolves.toMatchObject({ accuracy: 20 });
  });

  it('prefers fresh readings: an old precise fix loses after 30 s', () => {
    const t = new PositionTracker();
    t.start();
    g.fix(10, 24.1);
    vi.advanceTimersByTime(31_000);
    g.fix(60, 24.2);
    expect(t.best()).toMatchObject({ accuracy: 60, latitude: 24.2 });
  });

  it('keeps the latest reading when the device stops reporting (stationary laptop)', () => {
    const t = new PositionTracker();
    t.start();
    g.fix(80, 24.3);
    vi.advanceTimersByTime(120_000);
    expect(t.best()).toMatchObject({ accuracy: 80, latitude: 24.3 });
  });

  it('rejects immediately when permission is denied, and stops watching', async () => {
    const states: PositionState[] = [];
    const t = new PositionTracker((s) => states.push(s));
    t.start();
    const p = t.wait(100, 15_000);
    g.fail(POSITION_ERROR.DENIED);
    await expect(p).rejects.toMatchObject({ code: POSITION_ERROR.DENIED });
    expect(g.geo.clearWatch).toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ kind: 'error', code: POSITION_ERROR.DENIED });
  });

  it('ignores a transient error once a reading exists', async () => {
    const t = new PositionTracker();
    t.start();
    g.fix(40);
    g.fail(POSITION_ERROR.UNAVAILABLE);
    await expect(t.wait(100, 15_000)).resolves.toMatchObject({ accuracy: 40 });
  });

  it('times out without any reading', async () => {
    const t = new PositionTracker();
    t.start();
    const p = t.wait(100, 15_000);
    vi.advanceTimersByTime(15_000);
    await expect(p).rejects.toMatchObject({ code: POSITION_ERROR.TIMEOUT });
  });

  it('stop() forgets the readings, so a new attempt never reuses an old position', async () => {
    const t = new PositionTracker();
    t.start();
    g.fix(30, 24.9);
    t.stop();
    expect(t.best()).toBeNull();
    t.start();
    const p = t.wait(100, 15_000);
    g.fix(25, 24.5);
    await expect(p).resolves.toMatchObject({ latitude: 24.5 });
  });

  it('reports UNSUPPORTED when the browser has no geolocation', async () => {
    vi.stubGlobal('navigator', {});
    const t = new PositionTracker();
    t.start();
    await expect(t.wait(100, 15_000)).rejects.toMatchObject({ code: POSITION_ERROR.UNSUPPORTED });
  });
});
