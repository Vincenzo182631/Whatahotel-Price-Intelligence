import type { AnalysisResult, ExplanationBundle, ScoringConfig } from '@wahpi/core';
import { DEFAULT_CONFIG } from '@wahpi/core';

import { db, withTransaction, type Queryable } from '../client.js';

let cached: { config: ScoringConfig; loadedAt: number } | null = null;
const CONFIG_TTL_MS = 60_000;

/**
 * The active scoring configuration.
 *
 * Falls back to the compiled defaults when the table is empty so the engine
 * never fails closed on a missing row — but the fallback is reported, because
 * silently scoring on different config than the database says is exactly the
 * kind of drift that makes a stored analysis irreproducible.
 */
export async function loadActiveConfig(
  q?: Queryable,
): Promise<{ config: ScoringConfig; fromDatabase: boolean }> {
  if (cached && Date.now() - cached.loadedAt < CONFIG_TTL_MS) {
    return { config: cached.config, fromDatabase: true };
  }

  const { rows } = await db(q).query(
    'SELECT version, config FROM scoring_config WHERE is_active LIMIT 1',
  );
  const row = rows[0];
  if (!row) return { config: DEFAULT_CONFIG, fromDatabase: false };

  const config = row.config as ScoringConfig;
  cached = { config, loadedAt: Date.now() };
  return { config, fromDatabase: true };
}

export function clearConfigCache(): void {
  cached = null;
}

export interface PersistAnalysisInput {
  readonly publicId: string;
  readonly hotelId: number;
  readonly roomTypeId: number | null;
  readonly ratePlanId: number | null;
  readonly analysis: AnalysisResult;
  readonly bundle: ExplanationBundle;
}

/**
 * Persist a computed analysis with its full factor breakdown.
 *
 * This is what makes a customer complaint answerable months later, and the raw
 * material the calibration runbook reads.
 */
export async function persistAnalysis(input: PersistAnalysisInput): Promise<number> {
  const a = input.analysis;

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO analysis (
          public_id, hotel_id, room_type_id, rate_plan_id, comparability_class,
          check_in, nights, adults, children, currency,
          current_nightly_minor, current_total_minor, effective_nightly_minor,
          rate_observed_at, deal_score, deal_score_band, confidence, confidence_band,
          recommendation, gate_fired, reason_codes, caveat_codes,
          baseline_level, n_observations, baseline_p50_minor, baseline_p10_minor,
          baseline_p90_minor, baseline_min_minor, baseline_max_minor, percentile_rank,
          config_version, engine_version, decision_trace, explanation_bundle
       ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16::score_band_t,$17,$18::conf_band_t,
          $19::recommendation_t,$20,$21,$22,
          $23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34
       ) RETURNING id`,
      [
        input.publicId,
        input.hotelId,
        input.roomTypeId,
        input.ratePlanId,
        a.query.comparabilityClass,
        a.query.checkIn,
        a.query.nights,
        a.query.adults,
        a.query.children,
        a.query.currency,
        a.currentNightlyMinor,
        a.currentTotalMinor,
        a.effectiveNightlyMinor,
        a.dataAsOf,
        a.dealScore,
        a.dealScoreBand,
        a.confidence,
        a.confidenceBand,
        a.recommendation,
        a.gateFired,
        a.reasonCodes,
        a.caveatCodes,
        a.baseline.level,
        a.baseline.nObservations,
        a.baseline.typicalNightlyMinor,
        a.baseline.p10Minor,
        a.baseline.p90Minor,
        a.baseline.lowestMinor,
        a.baseline.highestMinor,
        a.baseline.percentileRank,
        a.configVersion,
        a.engineVersion,
        JSON.stringify(a.decisionTrace),
        JSON.stringify(input.bundle),
      ],
    );

    const analysisId = rows[0]?.id as number;

    for (const factor of a.factors) {
      await client.query(
        `INSERT INTO analysis_factor
           (analysis_id, factor_code, is_available, raw_value, sub_score,
            weight_applied, unavailable_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          analysisId,
          factor.code,
          factor.available,
          factor.rawValue,
          factor.subScore,
          factor.weightApplied,
          factor.unavailableReason,
        ],
      );
    }

    return analysisId;
  });
}

export async function findAnalysisByPublicId(
  publicId: string,
  q?: Queryable,
): Promise<Record<string, unknown> | null> {
  const { rows } = await db(q).query(
    `SELECT a.*,
            (SELECT json_agg(row_to_json(f)) FROM analysis_factor f
              WHERE f.analysis_id = a.id) AS factors
       FROM analysis a WHERE a.public_id = $1`,
    [publicId],
  );
  return rows[0] ?? null;
}

/** Cheap unique id for public URLs. Not security-sensitive, just unguessable enough. */
export function newPublicId(prefix = 'an'): string {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${prefix}_${out}`;
}
