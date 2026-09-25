// Geofence helpers for self clock-in. PURE functions only (no prisma, no server imports), so the
// portal page, the API routes and the unit tests share one implementation.
//
// Distances use the haversine formula on a spherical Earth (mean radius 6,371,008.8 m). Over the
// few hundred meters of a geofence the error vs. the WGS-84 ellipsoid is far below GPS accuracy.

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface GeoFence extends LatLng {
  /** Allowed radius around the center, in meters. */
  radiusM: number;
}

/** Radius limits accepted for an attendance location (meters). */
export const GEOFENCE_RADIUS_LIMITS = { min: 30, max: 2000 } as const;

export function isValidLatLng(latitude: unknown, longitude: unknown): boolean {
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/** Great-circle distance between two points, in meters. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface NearestFence<T extends GeoFence> {
  fence: T;
  /** Distance from the point to the fence center, in meters. */
  distanceM: number;
  /** True when the point is inside the fence (distance <= radius). */
  inside: boolean;
}

/**
 * The fence that matters for a point: the nearest one the point is inside of, otherwise the
 * nearest fence overall (to report "you are X m from <name>"). Null when there are no fences.
 */
export function nearestFence<T extends GeoFence>(point: LatLng, fences: readonly T[]): NearestFence<T> | null {
  let best: NearestFence<T> | null = null;
  for (const fence of fences) {
    const distanceM = haversineMeters(point, fence);
    const inside = distanceM <= fence.radiusM;
    if (
      !best ||
      (inside && !best.inside) ||
      (inside === best.inside && distanceM < best.distanceM)
    ) {
      best = { fence, distanceM, inside };
    }
  }
  return best;
}

const COORD = String.raw`(-?\d{1,3}(?:\.\d+)?)`;

function pair(latRaw: string | undefined, lngRaw: string | undefined): LatLng | null {
  if (latRaw === undefined || lngRaw === undefined) return null;
  const latitude = Number(latRaw);
  const longitude = Number(lngRaw);
  return isValidLatLng(latitude, longitude) && !(latitude === 0 && longitude === 0) ? { latitude, longitude } : null;
}

/**
 * Extracts coordinates from a pasted Google Maps link or a plain "lat, lng" text.
 * Supported: ".../@24.71,46.67,17z", "!3d24.71!4d46.67", "?q=24.71,46.67", "query=", "ll=",
 * "destination=", "center=". Short links (maps.app.goo.gl / goo.gl/maps) carry no coordinates
 * and return null: open them and copy the full address-bar link instead.
 * The place marker ("!3d…!4d…") wins over the map viewport ("@…") when both are present.
 */
export function parseLatLngFromMapsUrl(input: string | null | undefined): LatLng | null {
  if (!input) return null;
  const text = input.trim();
  if (!text || text.length > 4000) return null;

  let decoded = text;
  try {
    decoded = decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    // keep the raw text when it is not valid percent-encoding
  }

  const place = decoded.match(new RegExp(String.raw`!3d${COORD}!4d${COORD}`));
  if (place) return pair(place[1], place[2]);

  const param = decoded.match(new RegExp(String.raw`[?&](?:q|query|ll|destination|daddr|center)=(?:loc:)?\s*${COORD}\s*,\s*${COORD}`, 'i'));
  if (param) return pair(param[1], param[2]);

  const at = decoded.match(new RegExp(String.raw`@${COORD},${COORD}`));
  if (at) return pair(at[1], at[2]);

  const plain = decoded.match(new RegExp(String.raw`^${COORD}\s*,\s*${COORD}$`));
  if (plain) return pair(plain[1], plain[2]);

  return null;
}

/** Google Maps link that opens the given point (for "verify on the map" links). */
export function mapsLink(point: LatLng): string {
  return `https://www.google.com/maps?q=${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;
}
