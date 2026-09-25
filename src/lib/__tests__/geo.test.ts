import { describe, expect, it } from 'vitest';
import { haversineMeters, isValidLatLng, mapsLink, nearestFence, parseLatLngFromMapsUrl } from '@/lib/geo';

describe('haversineMeters', () => {
  it('one degree of latitude is ~111.195 km', () => {
    expect(haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })).toBeCloseTo(111_195.08, -1);
  });

  it('0.001 degree of latitude in Riyadh is ~111 m and symmetric', () => {
    const a = { latitude: 24.7136, longitude: 46.6753 };
    const b = { latitude: 24.7146, longitude: 46.6753 };
    expect(haversineMeters(a, b)).toBeCloseTo(111.2, 0);
    expect(haversineMeters(b, a)).toBeCloseTo(haversineMeters(a, b), 6);
    expect(haversineMeters(a, a)).toBe(0);
  });
});

describe('isValidLatLng', () => {
  it('accepts real coordinates and rejects out-of-range / non-numbers', () => {
    expect(isValidLatLng(24.7, 46.6)).toBe(true);
    expect(isValidLatLng(-90, 180)).toBe(true);
    expect(isValidLatLng(91, 0)).toBe(false);
    expect(isValidLatLng(0, -181)).toBe(false);
    expect(isValidLatLng(Number.NaN, 0)).toBe(false);
    expect(isValidLatLng('24.7', 46.6)).toBe(false);
  });
});

describe('nearestFence', () => {
  const office = { latitude: 24.7136, longitude: 46.6753 };

  it('returns null without fences', () => {
    expect(nearestFence(office, [])).toBeNull();
  });

  it('prefers a fence the point is inside of over a closer center it is outside of', () => {
    // A: 40 m away, radius 50 -> inside. B: ~22 m away, radius 10 -> outside.
    const a = { id: 'a', latitude: 24.71396, longitude: 46.6753, radiusM: 50 };
    const b = { id: 'b', latitude: 24.7138, longitude: 46.6753, radiusM: 10 };
    const r = nearestFence(office, [b, a]);
    expect(r?.fence.id).toBe('a');
    expect(r?.inside).toBe(true);
  });

  it('reports the nearest fence and distance when outside all of them', () => {
    const far = { id: 'far', latitude: 24.8, longitude: 46.6753, radiusM: 100 };
    const near = { id: 'near', latitude: 24.72, longitude: 46.6753, radiusM: 100 };
    const r = nearestFence(office, [far, near]);
    expect(r?.fence.id).toBe('near');
    expect(r?.inside).toBe(false);
    expect(r?.distanceM).toBeGreaterThan(600);
  });

  it('a point exactly on the radius counts as inside', () => {
    const fence = { id: 'f', latitude: 24.7146, longitude: 46.6753, radiusM: haversineMeters(office, { latitude: 24.7146, longitude: 46.6753 }) };
    expect(nearestFence(office, [fence])?.inside).toBe(true);
  });
});

describe('parseLatLngFromMapsUrl', () => {
  it('reads the map viewport "@lat,lng"', () => {
    expect(parseLatLngFromMapsUrl('https://www.google.com/maps/@24.7136,46.6753,17z')).toEqual({ latitude: 24.7136, longitude: 46.6753 });
  });

  it('prefers the place marker (!3d!4d) over the viewport', () => {
    const url = 'https://www.google.com/maps/place/X/@24.70,46.60,15z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d24.7136!4d46.6753';
    expect(parseLatLngFromMapsUrl(url)).toEqual({ latitude: 24.7136, longitude: 46.6753 });
  });

  it('reads q= / query= / ll= parameters, including encoded commas', () => {
    expect(parseLatLngFromMapsUrl('https://maps.google.com/?q=24.7136,46.6753')).toEqual({ latitude: 24.7136, longitude: 46.6753 });
    expect(parseLatLngFromMapsUrl('https://www.google.com/maps/search/?api=1&query=24.7136%2C46.6753')).toEqual({ latitude: 24.7136, longitude: 46.6753 });
    expect(parseLatLngFromMapsUrl('https://maps.google.com/maps?ll=21.4225,39.8262&z=16')).toEqual({ latitude: 21.4225, longitude: 39.8262 });
  });

  it('reads a plain "lat, lng" pair and negative values', () => {
    expect(parseLatLngFromMapsUrl(' 24.7136 , 46.6753 ')).toEqual({ latitude: 24.7136, longitude: 46.6753 });
    expect(parseLatLngFromMapsUrl('-33.8688,151.2093')).toEqual({ latitude: -33.8688, longitude: 151.2093 });
  });

  it('returns null for short links, junk, out-of-range and 0,0', () => {
    expect(parseLatLngFromMapsUrl('https://maps.app.goo.gl/AbCdEf123')).toBeNull();
    expect(parseLatLngFromMapsUrl('not a link')).toBeNull();
    expect(parseLatLngFromMapsUrl('')).toBeNull();
    expect(parseLatLngFromMapsUrl(null)).toBeNull();
    expect(parseLatLngFromMapsUrl('https://maps.google.com/?q=95.1,46.6')).toBeNull();
    expect(parseLatLngFromMapsUrl('0,0')).toBeNull();
  });
});

describe('mapsLink', () => {
  it('builds a Google Maps link with 6 decimals', () => {
    expect(mapsLink({ latitude: 24.7136, longitude: 46.6753 })).toBe('https://www.google.com/maps?q=24.713600,46.675300');
  });
});
