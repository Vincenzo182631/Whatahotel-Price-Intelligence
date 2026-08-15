import { describe, expect, it } from 'vitest';

import { analyze } from '../packages/core/src/analyze.js';
import { DEFAULT_CONFIG } from '../packages/core/src/config/defaults.js';
import { SCENARIOS } from './fixtures/scenarios.js';

describe('scenario suite (docs/mvp/07-testing.md §2)', () => {
  for (const scenario of SCENARIOS) {
    describe(`${scenario.id} — ${scenario.title}`, () => {
      const { analysis, bundle, explanation } = analyze(scenario.input, DEFAULT_CONFIG);
      const e = scenario.expect;

      it('produces the expected recommendation', () => {
        const allowed = Array.isArray(e.recommendation) ? e.recommendation : [e.recommendation];
        expect(allowed).toContain(analysis.recommendation);
      });

      if (e.gateFired !== undefined) {
        it(`fires gate ${e.gateFired}`, () => {
          expect(analysis.gateFired).toBe(e.gateFired);
        });
      }

      if (e.dealScore === null) {
        it('reports no deal score — null, never 0', () => {
          expect(analysis.dealScore).toBeNull();
          expect(analysis.dealScoreBand).toBeNull();
        });
      } else if (e.dealScore !== undefined) {
        const [lo, hi] = e.dealScore;
        it(`scores within [${lo}, ${hi}]`, () => {
          expect(analysis.dealScore).not.toBeNull();
          expect(analysis.dealScore).toBeGreaterThanOrEqual(lo);
          expect(analysis.dealScore).toBeLessThanOrEqual(hi);
        });
      }

      if (e.dealScoreBand !== undefined) {
        it(`lands in the ${e.dealScoreBand} band`, () => {
          expect(analysis.dealScoreBand).toBe(e.dealScoreBand);
        });
      }

      if (e.confidence !== undefined) {
        const [lo, hi] = e.confidence;
        it(`reports confidence within [${lo}, ${hi}]`, () => {
          expect(analysis.confidence).toBeGreaterThanOrEqual(lo);
          expect(analysis.confidence).toBeLessThanOrEqual(hi);
        });
      }

      if (e.confidenceBand !== undefined) {
        it(`lands in the ${e.confidenceBand} confidence band`, () => {
          expect(analysis.confidenceBand).toBe(e.confidenceBand);
        });
      }

      if (e.waitBlockedByIncludes !== undefined) {
        it(`blocks WAIT via ${e.waitBlockedByIncludes.join(', ')}`, () => {
          for (const guard of e.waitBlockedByIncludes ?? []) {
            expect(analysis.waitBlockedBy).toContain(guard);
          }
        });
      }

      if (e.reasonCodesInclude !== undefined) {
        it('surfaces the expected reasons', () => {
          for (const code of e.reasonCodesInclude ?? []) {
            expect(analysis.reasonCodes).toContain(code);
          }
        });
      }

      if (e.caveatCodesInclude !== undefined) {
        it('surfaces the expected caveats', () => {
          for (const code of e.caveatCodesInclude ?? []) {
            expect(analysis.caveatCodes).toContain(code);
          }
        });
      }

      it('renders an explanation whose numbers are all in the bundle allowlist', () => {
        const allowed = new Set(bundle.constraints.allowed_numbers);
        const numbers = extractNumbers(explanation.text);
        const tolerance = DEFAULT_CONFIG.explanation.numericTolerance;
        for (const n of numbers) {
          const ok = [...allowed].some((a) => Math.abs(a - n) <= tolerance);
          expect(ok, `number ${n} in "${explanation.text}" is not in the allowlist`).toBe(true);
        }
      });

      it('never emits WAIT below the confidence floor', () => {
        if (analysis.recommendation === 'WAIT') {
          expect(analysis.confidence).toBeGreaterThanOrEqual(DEFAULT_CONFIG.rec.wait.confidenceMin);
        }
      });
    });
  }
});

/** Pulls every numeral out of rendered prose, including inside $1,234 and 8%. */
export function extractNumbers(text: string): number[] {
  const matches = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return matches.map((m) => Number(m.replace(/,/g, ''))).filter((n) => Number.isFinite(n));
}
