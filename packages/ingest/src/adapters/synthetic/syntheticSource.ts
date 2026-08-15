/**
 * ⚠️  SYNTHETIC DEVELOPMENT DATA — NOT REAL HOTEL RATES.
 *
 * Every price this module produces is fabricated by a seeded pseudo-random
 * generator. It exists so the rollups, API and UI can be exercised end to end
 * before a real source is connected. It must never run against a production
 * database, and no number it produces may ever be shown to a customer.
 *
 * The generator is deterministic (seeded) so a developer looking at a strange
 * score can reproduce the exact dataset that caused it.
 *
 * Hotel names below are invented. They are placeholders, not claims about real
 * properties or their pricing.
 */

import type { RateQuery, RateSourceAdapter, RawRateRecord } from '../RateSourceAdapter.js';

export const SYNTHETIC_SOURCE_CODE = 'SYNTHETIC_DEV';

/** Deterministic PRNG (mulberry32) — reproducible datasets beat random ones. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface SyntheticHotel {
  readonly wahHotelId: string;
  readonly name: string;
  readonly destinationSlug: string;
  readonly destinationName: string;
  readonly countryCode: string;
  readonly brand: string;
  readonly luxuryTier: number;
  readonly starRating: number;
  readonly baseNightlyMinor: number;
  readonly rooms: readonly SyntheticRoom[];
}

export interface SyntheticRoom {
  readonly name: string;
  readonly sourceCode: string;
  readonly multiplier: number;
  readonly tierOrdinal: number;
}

const STANDARD_ROOMS: readonly SyntheticRoom[] = [
  { name: 'Superior King', sourceCode: 'SUPK', multiplier: 1.0, tierOrdinal: 0 },
  { name: 'Deluxe King', sourceCode: 'DLXK', multiplier: 1.18, tierOrdinal: 1 },
  { name: 'Ocean View King', sourceCode: 'OVK', multiplier: 1.42, tierOrdinal: 2 },
  { name: 'Junior Suite', sourceCode: 'JRSTE', multiplier: 1.85, tierOrdinal: 3 },
];

export const SYNTHETIC_HOTELS: readonly SyntheticHotel[] = [
  {
    wahHotelId: 'DEV-1001',
    name: 'Azure Sands Resort',
    destinationSlug: 'miami-beach',
    destinationName: 'Miami Beach',
    countryCode: 'US',
    brand: 'Azure Collection',
    luxuryTier: 5,
    starRating: 5,
    baseNightlyMinor: 62000,
    rooms: STANDARD_ROOMS,
  },
  {
    wahHotelId: 'DEV-1002',
    name: 'The Coral Reef Hotel',
    destinationSlug: 'miami-beach',
    destinationName: 'Miami Beach',
    countryCode: 'US',
    brand: 'Reef Hotels',
    luxuryTier: 5,
    starRating: 4.5,
    baseNightlyMinor: 58000,
    rooms: STANDARD_ROOMS,
  },
  {
    wahHotelId: 'DEV-1003',
    name: 'Palm Court Miami',
    destinationSlug: 'miami-beach',
    destinationName: 'Miami Beach',
    countryCode: 'US',
    brand: 'Palm Court',
    luxuryTier: 4,
    starRating: 4.5,
    baseNightlyMinor: 49000,
    rooms: STANDARD_ROOMS,
  },
  {
    wahHotelId: 'DEV-1004',
    name: 'Bayfront Grand',
    destinationSlug: 'miami-beach',
    destinationName: 'Miami Beach',
    countryCode: 'US',
    brand: 'Grand Group',
    luxuryTier: 5,
    starRating: 5,
    baseNightlyMinor: 71000,
    rooms: STANDARD_ROOMS,
  },
  {
    wahHotelId: 'DEV-1005',
    name: 'Ocean Terrace Suites',
    destinationSlug: 'miami-beach',
    destinationName: 'Miami Beach',
    countryCode: 'US',
    brand: 'Terrace Hotels',
    luxuryTier: 4,
    starRating: 4,
    baseNightlyMinor: 45000,
    rooms: STANDARD_ROOMS,
  },
  {
    wahHotelId: 'DEV-1006',
    name: 'Lakeview Alpine Lodge',
    destinationSlug: 'aspen',
    destinationName: 'Aspen',
    countryCode: 'US',
    brand: 'Alpine Retreats',
    luxuryTier: 5,
    starRating: 5,
    baseNightlyMinor: 88000,
    rooms: STANDARD_ROOMS,
  },
  {
    wahHotelId: 'DEV-1007',
    name: 'Summit House Aspen',
    destinationSlug: 'aspen',
    destinationName: 'Aspen',
    countryCode: 'US',
    brand: 'Summit Collection',
    luxuryTier: 5,
    starRating: 5,
    baseNightlyMinor: 94000,
    rooms: STANDARD_ROOMS,
  },
  {
    wahHotelId: 'DEV-1008',
    name: 'Cedar Ridge Inn',
    destinationSlug: 'aspen',
    destinationName: 'Aspen',
    countryCode: 'US',
    brand: 'Cedar Hotels',
    luxuryTier: 4,
    starRating: 4.5,
    baseNightlyMinor: 72000,
    rooms: STANDARD_ROOMS,
  },
  // A destination needs at least four hotels for every member to reach the
  // three-comparable minimum that factor F2 requires.
  {
    wahHotelId: 'DEV-1009',
    name: 'Glacier Point Hotel',
    destinationSlug: 'aspen',
    destinationName: 'Aspen',
    countryCode: 'US',
    brand: 'Glacier Hotels',
    luxuryTier: 5,
    starRating: 4.5,
    baseNightlyMinor: 81000,
    rooms: STANDARD_ROOMS,
  },
];

export interface RatePlanSpec {
  readonly code: string;
  readonly name: string;
  readonly mealPlan: string;
  readonly refundPolicy: string;
  readonly audience: string;
  readonly multiplier: number;
}

export const SYNTHETIC_RATE_PLANS: readonly RatePlanSpec[] = [
  {
    code: 'BB-FLEX',
    name: 'Bed and breakfast, flexible',
    mealPlan: 'BREAKFAST',
    refundPolicy: 'REFUNDABLE',
    audience: 'PUBLIC',
    multiplier: 1.0,
  },
  {
    code: 'RO-ADV',
    name: 'Room only, advance purchase',
    mealPlan: 'ROOM_ONLY',
    refundPolicy: 'NON_REFUNDABLE',
    audience: 'PUBLIC',
    multiplier: 0.86,
  },
];

/** Seasonal shape by month, keyed 1–12. Peaks in winter and midsummer. */
const SEASONAL_MULTIPLIER: readonly number[] = [
  1.18, 1.14, 1.06, 0.96, 0.92, 1.02, 1.12, 1.14, 0.94, 0.93, 0.98, 1.2,
];

function seasonalFactor(isoDate: string): number {
  const month = Number(isoDate.slice(5, 7));
  return SEASONAL_MULTIPLIER[month - 1] ?? 1;
}

function weekendFactor(isoDate: string): number {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return day === 5 || day === 6 ? 1.12 : 1.0;
}

/** Rates firm up as the stay approaches — a real, and testable, market shape. */
function leadTimeFactor(leadDays: number): number {
  if (leadDays <= 3) return 1.14;
  if (leadDays <= 7) return 1.09;
  if (leadDays <= 14) return 1.05;
  if (leadDays <= 30) return 1.0;
  if (leadDays <= 60) return 0.97;
  return 0.95;
}

export interface SyntheticOptions {
  readonly seed: number;
  /** How far back observations are generated. */
  readonly historyDays: number;
  /** Random walk amplitude per day, as a fraction. */
  readonly volatility: number;
}

export const DEFAULT_SYNTHETIC_OPTIONS: SyntheticOptions = {
  seed: 20260815,
  historyDays: 90,
  volatility: 0.02,
};

/**
 * Generate one observation.
 *
 * `observedAt` and `checkIn` move independently, which is the whole point —
 * a dataset where they are coupled would never exercise the lead-time
 * stratification the ladder depends on.
 */
export function syntheticRate(
  hotel: SyntheticHotel,
  room: SyntheticRoom,
  plan: RatePlanSpec,
  checkIn: string,
  nights: number,
  adults: number,
  observedAt: Date,
  options: SyntheticOptions,
): RawRateRecord {
  const observedDate = observedAt.toISOString().slice(0, 10);
  const leadDays = Math.round(
    (Date.parse(`${checkIn}T00:00:00Z`) - Date.parse(`${observedDate}T00:00:00Z`)) / 86_400_000,
  );

  const rng = seededRandom(
    options.seed ^ hashString(`${hotel.wahHotelId}|${room.sourceCode}|${plan.code}|${checkIn}`),
  );

  // A slow random walk over observation time, so the same stay has a coherent
  // history rather than independent noise on each capture.
  let walk = 1;
  const steps = Math.max(0, options.historyDays - leadDays);
  for (let i = 0; i < steps; i += 1) {
    walk *= 1 + (rng() - 0.5) * 2 * options.volatility;
  }
  walk = Math.min(1.35, Math.max(0.72, walk));

  const occupancyFactor = adults >= 3 ? 1.15 : 1;

  const nightly =
    hotel.baseNightlyMinor *
    room.multiplier *
    plan.multiplier *
    seasonalFactor(checkIn) *
    weekendFactor(checkIn) *
    leadTimeFactor(leadDays) *
    occupancyFactor *
    walk;

  const totalNet = Math.round(nightly) * nights;
  const taxes = Math.round(totalNet * 0.135);

  return {
    wahHotelId: hotel.wahHotelId,
    rawRoomName: room.name,
    sourceRoomCode: room.sourceCode,
    sourcePlanCode: plan.code,
    rawPlanName: plan.name,
    checkIn,
    nights,
    adults,
    children: 0,
    currency: 'USD',
    totalAmountMinor: totalNet + taxes,
    totalGrossAmountMinor: totalNet + taxes,
    taxesFeesMinor: taxes,
    taxBasis: 'GROSS',
    mealPlan: plan.mealPlan,
    refundPolicy: plan.refundPolicy,
    isPrepaid: plan.refundPolicy === 'NON_REFUNDABLE',
    audience: plan.audience,
    roomsLeft: leadDays <= 14 ? Math.max(1, Math.round(rng() * 8)) : null,
    isAvailable: true,
    observedAt: observedAt.toISOString(),
    raw: { synthetic: true, hotel: hotel.wahHotelId, room: room.sourceCode, plan: plan.code },
  };
}

/**
 * A development adapter. Deliberately NOT registered anywhere automatically —
 * it must be selected explicitly by the dev seed script.
 */
export function createSyntheticAdapter(
  options: SyntheticOptions = DEFAULT_SYNTHETIC_OPTIONS,
): RateSourceAdapter {
  return {
    code: SYNTHETIC_SOURCE_CODE,
    displayName: 'Synthetic development data (NOT REAL RATES)',
    isAuthoritative: false,
    async fetchRates(queries: readonly RateQuery[]): Promise<RawRateRecord[]> {
      const now = new Date();
      const out: RawRateRecord[] = [];
      for (const query of queries) {
        const hotel = SYNTHETIC_HOTELS.find((h) => h.wahHotelId === query.wahHotelId);
        if (!hotel) continue;
        for (const room of hotel.rooms) {
          for (const plan of SYNTHETIC_RATE_PLANS) {
            out.push(
              syntheticRate(
                hotel,
                room,
                plan,
                query.checkIn,
                query.nights,
                query.adults,
                now,
                options,
              ),
            );
          }
        }
      }
      return out;
    },
  };
}
