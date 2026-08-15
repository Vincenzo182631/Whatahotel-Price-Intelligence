/**
 * The interface every rate source implements.
 *
 * The proposal (§9) requires multi-source support, and the assessment flagged
 * that no licensable source is guaranteed to permit storing and displaying rate
 * history (risk R1). This boundary is the insurance: a source can be swapped
 * without the scoring engine, the schema, or the API changing.
 *
 * NO PRODUCTION ADAPTER EXISTS YET. Writing one requires answers to U1–U18 in
 * docs/mvp/README.md — specifically the real payload shape, whether rates can be
 * fetched for arbitrary future dates, and whether room types and cancellation
 * terms arrive as structured fields. Guessing at those would produce an adapter
 * that compiles and silently mis-maps every rate.
 */

export interface RateQuery {
  readonly wahHotelId: string;
  readonly checkIn: string;
  readonly nights: number;
  readonly adults: number;
  readonly children: number;
  readonly currency: string;
}

/**
 * A rate exactly as the source described it, before normalization.
 *
 * Room and rate-plan fields are raw strings on purpose: normalization is the
 * pipeline's job (docs/mvp/01 §3–4), and an adapter that pre-normalizes hides
 * the match confidence the engine needs.
 */
export interface RawRateRecord {
  readonly wahHotelId: string;
  readonly rawRoomName: string;
  readonly sourceRoomCode?: string | null;
  readonly sourcePlanCode?: string | null;
  readonly rawPlanName?: string | null;

  readonly checkIn: string;
  readonly nights: number;
  readonly adults: number;
  readonly children: number;

  readonly currency: string;
  readonly totalAmountMinor: number;
  readonly totalGrossAmountMinor?: number | null;
  readonly taxesFeesMinor?: number | null;
  readonly taxBasis: 'NET' | 'GROSS' | 'UNKNOWN';

  readonly mealPlan?: string | null;
  readonly refundPolicy?: string | null;
  readonly isPrepaid?: boolean | null;
  readonly audience?: string | null;

  readonly roomsLeft?: number | null;
  readonly isAvailable: boolean;
  readonly observedAt: string;

  /** The original payload, stored verbatim. The only thing that can settle a dispute later. */
  readonly raw: unknown;
}

export interface RateSourceAdapter {
  readonly code: string;
  readonly displayName: string;
  readonly isAuthoritative: boolean;
  fetchRates(queries: readonly RateQuery[]): Promise<RawRateRecord[]>;
}
