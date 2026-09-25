// Shared validation for the attendance-location routes (route files may only export handlers).
import { ROLE_GROUPS } from '@/lib/constants';
import { GEOFENCE_RADIUS_LIMITS } from '@/lib/geo';
import { zInt, zNumber } from '@/lib/validation';

/** Same writers as branches (src/app/api/branches/[id]/route.ts). */
export const LOCATION_WRITERS = [...new Set([...ROLE_GROUPS.ADMIN, ...ROLE_GROUPS.HR])];

export const latitudeSchema = zNumber.refine((n) => n >= -90 && n <= 90, 'خط العرض يجب أن يكون بين -90 و 90');
export const longitudeSchema = zNumber.refine((n) => n >= -180 && n <= 180, 'خط الطول يجب أن يكون بين -180 و 180');
export const radiusSchema = zInt.refine(
  (n) => n >= GEOFENCE_RADIUS_LIMITS.min && n <= GEOFENCE_RADIUS_LIMITS.max,
  `نصف القطر يجب أن يكون بين ${GEOFENCE_RADIUS_LIMITS.min} و ${GEOFENCE_RADIUS_LIMITS.max} متر`,
);

export const locationSelect = {
  id: true,
  branchId: true,
  name: true,
  latitude: true,
  longitude: true,
  radiusM: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;
