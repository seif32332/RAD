// Browser-only helper: follows the device position for a short while (while the camera is open,
// or while HR fills in a location) and keeps the most precise recent reading.
//
// Why not a single getCurrentPosition(): a phone's first fix is often coarse (Wi-Fi / cell towers,
// hundreds of metres) and the GPS fix only arrives a few seconds later, so taking the first
// reading rejects employees who are actually on site. Every retry must also use fresh readings,
// never a position captured before the employee moved closer to a window.

export interface DevicePosition {
  latitude: number;
  longitude: number;
  /** Radius of the browser's confidence circle, metres. */
  accuracy: number;
  /** Date.now() of the reading. */
  at: number;
}

export type PositionState = { kind: 'locating' } | { kind: 'ready'; position: DevicePosition } | { kind: 'error'; code: number };

/** W3C GeolocationPositionError codes, plus UNSUPPORTED for browsers without the API. */
export const POSITION_ERROR = { UNSUPPORTED: 0, DENIED: 1, UNAVAILABLE: 2, TIMEOUT: 3 } as const;

export class PositionError extends Error {
  constructor(readonly code: number) {
    super(`geolocation error ${code}`);
    this.name = 'PositionError';
  }
}

/** Readings older than this lose to fresher ones (the person may be walking). */
const MAX_READING_AGE_MS = 30_000;
const MAX_READINGS = 50;

export class PositionTracker {
  private watchId: number | null = null;
  private readings: DevicePosition[] = [];
  private errorCode: number | null = null;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly onChange?: (state: PositionState) => void) {}

  /** Starts watching (no-op while already watching). */
  start(): void {
    if (this.watchId !== null) return;
    this.readings = [];
    this.errorCode = null;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      this.fail(POSITION_ERROR.UNSUPPORTED);
      return;
    }
    this.onChange?.({ kind: 'locating' });
    this.watchId = navigator.geolocation.watchPosition(
      (p) => {
        this.readings.push({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() });
        if (this.readings.length > MAX_READINGS) this.readings.shift();
        this.errorCode = null;
        const best = this.best();
        if (best) this.onChange?.({ kind: 'ready', position: best });
        this.wake();
      },
      (err) => {
        // A hiccup between fixes does not matter while a usable reading exists.
        if (err.code !== POSITION_ERROR.DENIED && this.readings.length) return;
        this.fail(err.code);
      },
      { enableHighAccuracy: true, maximumAge: 0 },
    );
  }

  /** Stops watching and forgets the readings. Pending wait() calls reject. */
  stop(): void {
    if (this.watchId !== null && typeof navigator !== 'undefined' && navigator.geolocation) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.readings = [];
    this.wake();
  }

  /**
   * The most precise reading of the last 30 s. A device that stands still may stop reporting
   * (desktop browsers only report changes), so the latest reading is used when none is recent.
   */
  best(): DevicePosition | null {
    const now = Date.now();
    let best: DevicePosition | null = null;
    for (const r of this.readings) if (now - r.at <= MAX_READING_AGE_MS && (!best || r.accuracy < best.accuracy)) best = r;
    return best ?? this.readings[this.readings.length - 1] ?? null;
  }

  /**
   * Resolves with the best reading as soon as it is within `targetM`, or after `maxWaitMs` with
   * the best reading available (even if less precise: the server gives the final answer).
   * Rejects with a PositionError when no reading could be obtained.
   */
  wait(targetM: number, maxWaitMs: number): Promise<DevicePosition> {
    return new Promise((resolve, reject) => {
      // Holder, because settle() may run (and clean up) before the timer exists.
      const pending: { timer?: ReturnType<typeof setTimeout> } = {};
      const settle = (final: boolean): boolean => {
        const best = this.best();
        if (best && (best.accuracy <= targetM || final)) {
          cleanup();
          resolve(best);
          return true;
        }
        const permanent = this.errorCode === POSITION_ERROR.DENIED || this.errorCode === POSITION_ERROR.UNSUPPORTED;
        if (final || permanent || this.watchId === null) {
          cleanup();
          reject(new PositionError(this.errorCode ?? POSITION_ERROR.TIMEOUT));
          return true;
        }
        return false;
      };
      const onUpdate = () => {
        settle(false);
      };
      const cleanup = () => {
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        this.waiters.delete(onUpdate);
      };
      if (settle(false)) return;
      this.waiters.add(onUpdate);
      pending.timer = setTimeout(() => settle(true), maxWaitMs);
    });
  }

  private fail(code: number): void {
    this.errorCode = code;
    if (code === POSITION_ERROR.DENIED && this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.onChange?.({ kind: 'error', code });
    this.wake();
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }
}
