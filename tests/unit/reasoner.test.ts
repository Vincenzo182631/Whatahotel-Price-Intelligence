/**
 * The reasoning layer, on every path it can take.
 *
 * These run with no OPENAI_API_KEY and no network: `fetch` is replaced for the
 * duration of each test. What is being held here is not that the model is
 * good — we cannot test that — but that a bad answer never reaches a customer:
 *
 *   no key            → the deterministic sentences, unchanged
 *   call fails        → the deterministic sentences, unchanged
 *   fabricated number → rejected whole, deterministic sentences
 *   forecast          → rejected whole, deterministic sentences
 *   valid draft       → the model's sentences, and cached for the next asker
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from '../../packages/core/src/index.js';
import { buildLiveExplanationBundle } from '../../packages/core/src/explanation/liveBundle.js';
import { renderLiveExplanation } from '../../packages/core/src/explanation/liveTemplate.js';
import {
  computeCalendarDelta,
  computeCompression,
  computeCompSetIndex,
  computePremiumJustification,
} from '../../packages/core/src/scoring/liveSignals.js';
import { composeLiveScore } from '../../packages/core/src/scoring/liveScore.js';
import {
  OpenAiReasoner,
  bundleKey,
  explainLive,
} from '../../packages/ingest/src/adapters/openai/reasoner.js';

const NOW = new Date('2026-08-21T00:00:00Z');
const OBSERVED = '2026-08-20T23:00:00Z';

function bundle() {
  const comps = [48_000, 50_000, 52_000, 55_000].map((n, i) => ({
    hotelId: `c${i}`,
    name: `Competitor ${i}`,
    nightlyMinor: n,
    observedAt: OBSERVED,
    isAvailable: true,
  }));
  const premium = computePremiumJustification(44_200, null, comps, DEFAULT_CONFIG);
  const compSet = computeCompSetIndex(
    44_200,
    comps,
    DEFAULT_CONFIG,
    NOW,
    { strength: 'RESOLVED', unknown: [] },
    null,
  );
  const calendar = computeCalendarDelta(
    44_200,
    [{ checkIn: '2026-09-03', nightlyMinor: 46_000, observedAt: OBSERVED, sameDow: true }],
    DEFAULT_CONFIG,
  );
  const compression = computeCompression({ checked: 8, soldOut: 3 }, DEFAULT_CONFIG);

  return buildLiveExplanationBundle({
    configVersion: DEFAULT_CONFIG.version,
    hotelName: 'Loews Miami Beach',
    roomTypeName: 'Corner King',
    checkIn: '2026-09-10',
    checkOut: '2026-09-13',
    nights: 3,
    adults: 2,
    children: 0,
    currency: 'USD',
    nightlyMinor: 44_200,
    totalMinor: 132_600,
    observedAt: OBSERVED,
    result: composeLiveScore(compSet, calendar, compression, 1, DEFAULT_CONFIG),
    compSet,
    calendar,
    compression,
    premium,
  });
}

/** A fetch that answers with whatever `summary` is given. */
function respondWith(summary: string) {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary }) } }] }),
        {
          status: 200,
        },
      ),
  );
}

const reasoner = () =>
  new OpenAiReasoner({ apiKey: 'test-key-not-real', endpoint: 'https://example.invalid/x' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('explainLive with no reasoner', () => {
  it('returns the deterministic sentences', async () => {
    const b = bundle();
    const out = await explainLive(null, b);
    expect(out.source).toBe('TEMPLATE');
    expect(out.text).toBe(renderLiveExplanation(b).text);
    expect(out.failure).toBe('not_configured');
  });
});

describe('OpenAiReasoner', () => {
  it('is null when unconfigured, so the disabled path cannot be forgotten', () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(OpenAiReasoner.fromEnv()).toBeNull();
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  });

  it('uses a valid draft and marks it MODEL', async () => {
    const b = bundle();
    // Every numeral below is on the bundle's allowlist by construction.
    const draft = `Corner King at Loews Miami Beach is $442 a night. We rate it ${b.verdict.out_of_ten} out of 10.`;
    vi.stubGlobal('fetch', respondWith(draft));

    const out = await reasoner().explain(b);
    expect(out.source).toBe('MODEL');
    expect(out.text).toBe(draft);
  });

  it('discards a draft that invents a number', async () => {
    const b = bundle();
    vi.stubGlobal('fetch', respondWith('This room is 37% below the market median.'));

    const out = await reasoner().explain(b);
    expect(out.source).toBe('TEMPLATE');
    expect(out.text).toBe(renderLiveExplanation(b).text);
    expect(out.violations.join(' ')).toContain('37');
  });

  it('discards a draft that forecasts a price', async () => {
    const b = bundle();
    vi.stubGlobal('fetch', respondWith('A good rate — prices will rise closer to the date.'));

    const out = await reasoner().explain(b);
    expect(out.source).toBe('TEMPLATE');
    expect(out.violations.join(' ')).toContain('predictive');
  });

  it('falls back when the call fails', async () => {
    const b = bundle();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 429 })),
    );

    const out = await reasoner().explain(b);
    expect(out.source).toBe('TEMPLATE');
  });

  it('falls back when the call throws', async () => {
    const b = bundle();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('aborted');
      }),
    );

    const out = await reasoner().explain(b);
    expect(out.source).toBe('TEMPLATE');
    expect(out.failure).toBe('timeout_or_network');
  });

  it('hands the model the bundle and nothing else, with the key in a header', async () => {
    const b = bundle();
    const spy = respondWith('Corner King at Loews Miami Beach is $442 a night.');
    vi.stubGlobal('fetch', spy);

    await reasoner().explain(b);

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    // The key is a credential: header only, never in a URL that might be
    // logged, and never in the payload.
    expect(url).not.toContain('test-key-not-real');
    expect((init.headers as Record<string, string>).Authorization).toContain('test-key-not-real');

    const payload = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(payload.messages).toHaveLength(2);
    expect(payload.messages[1]?.role).toBe('user');
    // The user turn is the bundle verbatim — no rates, no database rows, no
    // hotel knowledge beyond the facts the engine already decided.
    expect(JSON.parse(payload.messages[1]?.content as string)).toEqual(b);
  });

  it('serves a second identical request from cache without calling again', async () => {
    const b = bundle();
    const spy = respondWith('Corner King at Loews Miami Beach is $442 a night.');
    vi.stubGlobal('fetch', spy);

    const r = reasoner();
    const first = await r.explain(b);
    const second = await r.explain(b);
    expect(first.source).toBe('MODEL');
    expect(second.source).toBe('CACHE');
    expect(second.text).toBe(first.text);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keys the cache on the facts, so a changed price is a fresh answer', () => {
    const same = bundleKey(bundle());
    expect(bundleKey(bundle())).toBe(same);

    const moved = bundle();
    const changed = { ...moved, price: { ...moved.price, nightly_minor: 45_900 } };
    expect(bundleKey(changed)).not.toBe(same);
  });
});
