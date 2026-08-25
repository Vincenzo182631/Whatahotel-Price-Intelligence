/**
 * WhataHotel Price Intelligence — embeddable widget.
 *
 * Framework-free on purpose: this mounts inside a third-party page, and a
 * framework payload is cost the host pays for no benefit here.
 *
 * Presentation rules it enforces (docs/mvp/08 §5), because breaking any of them
 * makes the product misleading rather than merely ugly:
 *   1. Never show a Deal Score without its confidence.
 *   2. Never show 0 for an absent score — absence is null and renders as text.
 *   3. Never imply prediction.
 *   4. Never rely on colour alone; every band carries a text label.
 *   5. Round consistently.
 *   7. Relative timestamps, absolute on hover.
 *
 * Two models, one mount:
 *   model: 'live'    (default) the live-market answer — this hotel against its
 *                    comp set, these dates against nearby bookable dates, and
 *                    how much of the comparable market is left. No history
 *                    needed, so it answers from the first week of collection.
 *   model: 'history' the accrued-history analysis (/api/v1/price-intelligence).
 *
 * Neither one predicts. Rule 3 below is not a style note: no string this file
 * renders may say what a price will do.
 *
 * Usage:
 *   WahPriceIntelligence.mount(element, {
 *     apiBase, hotelId, checkIn, checkOut, adults, children, roomTypeId, model
 *   });
 */
(function (global) {
  'use strict';

  // The API lives wherever this script was loaded from, so a host page that
  // uses the <div data-wah-pi> form needs no configuration at all. An explicit
  // apiBase (option or data-attribute) still wins.
  var DEFAULT_API_BASE = '';
  try {
    var currentScript = typeof document !== 'undefined' && document.currentScript;
    if (currentScript && currentScript.src) {
      DEFAULT_API_BASE = new URL(currentScript.src).origin;
    }
  } catch (e) {
    /* older browsers: fall back to same-origin */
  }

  // ── formatting ─────────────────────────────────────────────────────────
  function formatMoney(money) {
    if (!money || money.amount_minor === null || money.amount_minor === undefined) return '—';
    var major = Math.round(money.amount_minor / 100);
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: money.currency || 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(major);
  }

  /** Rule 5: one decimal below 10%, whole numbers above. */
  function formatPct(value) {
    if (value === null || value === undefined) return '—';
    var abs = Math.abs(value);
    return (abs < 10 ? abs.toFixed(1) : String(Math.round(abs))) + '%';
  }

  function relativeTime(iso) {
    var seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (seconds < 90) return 'just now';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
    var hours = Math.round(minutes / 60);
    if (hours < 48) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    var days = Math.round(hours / 24);
    return days + (days === 1 ? ' day ago' : ' days ago');
  }

  /**
   * The tax wording for a price block.
   *
   * The nightly figure is the ADR — the base room rate, the same basis
   * whatahotel.com quotes — while the total is the full cost of the stay.
   * They differ, so one label has to name both or it is wrong about one.
   */
  function taxLabel(price) {
    var nightlyBasis = price.nightly_basis || 'NET';
    var totalBasis = price.total_basis || price.tax_basis;
    if (nightlyBasis === 'NET' && totalBasis === 'GROSS') {
      return 'Nightly rate before taxes and fees · total includes them';
    }
    if (totalBasis === 'GROSS') return 'Includes taxes and fees';
    if (totalBasis === 'NET') return 'Before taxes and fees';
    return 'Nightly rate before taxes and fees · total tax treatment unconfirmed';
  }

  /**
   * "[Room category] + [bedding]" and nothing else. Source room names carry
   * an amenity tail ("…, Mini fridge, 420sqft, Wireless internet") that a
   * guest scanning a rate card does not need. Keep the words before the
   * first period, then at most two comma segments — the category and the
   * bedding — which matches names like "Historic Room, 1 King, Mini
   * fridge," down to "Historic Room, 1 King".
   */
  function conciseRoomName(name) {
    if (!name) return '';
    var head = String(name).split('.')[0];
    var parts = head.split(',').map(function (p) { return p.trim(); }).filter(Boolean);
    return parts.slice(0, 2).join(', ');
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function section(title) {
    var wrap = el('section', 'wahpi__section');
    if (title) wrap.appendChild(el('h3', null, title));
    return wrap;
  }

  var PREMIUM_LABEL = {
    HIGH: 'Premium appears supported',
    MODERATE: 'Premium may be reasonable',
    LOW: 'Higher-priced option',
    LIMITED_DATA: 'Limited data',
  };

  var PREMIUM_TONE = {
    HIGH: 'wahpi--good',
    MODERATE: 'wahpi--neutral',
    LOW: 'wahpi--bad',
    LIMITED_DATA: 'wahpi--neutral',
  };

  // Consultative frames, keyed on the API's `position`. The intelligence
  // underneath is unchanged; the customer-facing register is an advisor's,
  // not a critic's — no "LOW", no "bad", no verdict on the guest's choice.
  var POSITION_LABEL = {
    PREMIUM_APPEARS_SUPPORTED: 'Premium appears supported',
    PREMIUM_MAY_BE_REASONABLE: 'Premium may be reasonable',
    HIGHER_PRICED_OPTION: 'Higher-priced option',
    SIGNIFICANT_PREMIUM: 'Significant premium',
    SIGNIFICANT_PREMIUM_LIMITED_AVAILABILITY: 'Significant premium — limited availability',
    LIMITED_DATA: 'Limited data',
  };

  var POSITION_TONE = {
    PREMIUM_APPEARS_SUPPORTED: 'wahpi--good',
    PREMIUM_MAY_BE_REASONABLE: 'wahpi--neutral',
    HIGHER_PRICED_OPTION: 'wahpi--neutral',
    SIGNIFICANT_PREMIUM: 'wahpi--warn',
    SIGNIFICANT_PREMIUM_LIMITED_AVAILABILITY: 'wahpi--warn',
    LIMITED_DATA: 'wahpi--neutral',
  };

  // ── WhataRate! Check branding ──────────────────────────────────────────

  /**
   * The product header. "WhataRate! Check / Live Rate Comparison" is the
   * official name — exact words, not a slot for the host page to restyle
   * into something else. The LIVE marker is honest: everything below it is
   * measured from the most recent verified rates (no historical pricing
   * exists for this source), so the badge states the product's actual basis.
   */
  function renderBrand() {
    var wrap = el('header', 'wahpi__brand');
    var row = el('div', 'wahpi__brand-row');
    var name = el('div', 'wahpi__brand-name');
    name.appendChild(el('span', 'wahpi__brand-what', 'WhataRate!'));
    name.appendChild(el('span', 'wahpi__brand-check', ' Check'));
    row.appendChild(name);
    var live = el('span', 'wahpi__brand-live');
    live.appendChild(el('span', 'wahpi__brand-live-dot', ''));
    live.appendChild(el('span', null, 'LIVE'));
    row.appendChild(live);
    wrap.appendChild(row);
    wrap.appendChild(el('div', 'wahpi__brand-sub', 'Live Rate Comparison'));
    return wrap;
  }

  /**
   * The Vibss chat widget WhataHotel already runs, loaded on demand.
   *
   * Inspected (plugin.js, v=2026-01-26): the public API is exactly
   * `setup({ id, color, agentName })` plus `reload`/`setAllowedDomains` —
   * there is no documented option for programmatic opening, an initial
   * message, or context injection. So the handoff uses what IS supported:
   * setup() renders a launcher inside `#vibss-webchat-<id>`, and Get Help
   * clicks that launcher. Prefilling the visible chat input with the stay
   * context is attempted best-effort and abandoned silently if the DOM
   * isn't where the current plugin build puts it — the chat still opens.
   *
   * One instance only: if the host page already ran the official snippet,
   * that instance is reused and no second script is injected.
   */
  var VIBSS_PLUGIN_URL = 'https://vibss.io/plugin.js?v=2026-01-26';
  var VIBSS_DEFAULT_ID = '4e75aaa1-3c96-4200-bcdb-86f4a3596e2e';

  /**
   * The chatbot already on the page, WHATEVER id the host installed it
   * under. whatahotel.com's own pages run Vibss with their own bot id, and
   * "use the existing WhataHotel chatbot" means that one — keying on our
   * configured id here would miss it and stand up a second bot beside it,
   * which is the one thing the integration must never do. The configured
   * id matters only on pages with no chatbot at all (the demo harness).
   */
  function vibssContainer(chatId) {
    return (
      document.querySelector('[id^="vibss-webchat-"]') ||
      document.getElementById('vibss-webchat-' + chatId)
    );
  }

  function ensureVibss(chatId, done) {
    if (vibssContainer(chatId)) return done(true);
    if (global.vibssWebChat && typeof global.vibssWebChat.setup === 'function') {
      try {
        global.vibssWebChat.setup({ id: chatId });
      } catch (e) {
        return done(false);
      }
      return done(true);
    }
    var existing = document.querySelector('script[src^="https://vibss.io/plugin.js"]');
    if (!existing) {
      existing = document.createElement('script');
      existing.src = VIBSS_PLUGIN_URL;
      document.body.appendChild(existing);
    }
    var tries = 0;
    (function poll() {
      if (vibssContainer(chatId)) return done(true);
      if (global.vibssWebChat && typeof global.vibssWebChat.setup === 'function') {
        try {
          if (!vibssContainer(chatId)) global.vibssWebChat.setup({ id: chatId });
        } catch (e) {
          return done(false);
        }
        return done(true);
      }
      if ((tries += 1) > 50) return done(false);
      setTimeout(poll, 200);
    })();
  }

  /** The launcher is the first button the plugin renders in its container. */
  function openVibss(chatId, contextText) {
    var tries = 0;
    (function poll() {
      var container = vibssContainer(chatId);
      var launcher = container && container.querySelector('button');
      if (launcher) {
        launcher.click();
        if (contextText) prefillVibss(container, contextText);
        return;
      }
      if ((tries += 1) <= 50) setTimeout(poll, 200);
    })();
  }

  /**
   * The chat's MESSAGE COMPOSER, and nothing else.
   *
   * Verified on the live whatahotel.com install: the bot opens with a
   * pre-chat form (Name / Email / Phone) before any conversation exists,
   * and "the first text input in the container" was the NAME field — the
   * context prefill landed in it. So an element qualifies only when it is
   * a textarea, or an input whose own labelling says it takes a message;
   * anything labelled like a contact field is explicitly refused. No
   * composer found means no prefill, never a guess.
   */
  function vibssComposer(container) {
    var ta = container.querySelector('textarea');
    if (ta) return ta;
    var inputs = container.querySelectorAll('input[type="text"], input:not([type])');
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      var hint = (
        (input.placeholder || '') +
        ' ' +
        (input.getAttribute('aria-label') || '') +
        ' ' +
        (input.name || '') +
        ' ' +
        (input.id || '')
      ).toLowerCase();
      if (/name|email|phone|subject|company/.test(hint)) continue;
      if (/message|chat|type|write|ask/.test(hint)) return input;
    }
    return null;
  }

  /**
   * Best-effort context prefill. The plugin's chat input is React-controlled,
   * so the value is set through the native setter and announced with an
   * input event — the supported pattern for controlled inputs. The guest
   * sees the text in the box and chooses to send it; nothing is sent on
   * their behalf. Polling is patient because the live bot shows a pre-chat
   * form first: the composer only exists once the guest starts the chat,
   * and the context should still be waiting for them when it does. Every
   * step is guarded; no composer simply means the chat opens without a
   * prefill.
   */
  function prefillVibss(container, text) {
    var tries = 0;
    (function poll() {
      var input = vibssComposer(container);
      if (input) {
        if (input.value && input.value.trim() !== '') return; // never overwrite the guest
        try {
          var proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
          var setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value');
          if (setter && setter.set) setter.set.call(input, text);
          else input.value = text;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (e) {
          /* the open chat is the deliverable; the prefill is a bonus */
        }
        return;
      }
      if ((tries += 1) <= 240) setTimeout(poll, 500);
    })();
  }

  /**
   * The stay, as one plain sentence the guest can send to an advisor.
   * Built ONLY from values actually on screen — nothing invented, nothing
   * padded. Absent facts are simply not mentioned.
   */
  function helpContext(data, options) {
    if (!data) return '';
    try {
      var parts = [];
      var hotel = data.subject && data.subject.hotel;
      var stay = data.subject && data.subject.stay;
      var room = data.subject && data.subject.room_type;
      if (hotel && hotel.name) {
        parts.push(
          "I'm looking at " +
            hotel.name +
            (hotel.destination ? ' in ' + hotel.destination : '') +
            (hotel.hotel_id ? ' (hotel ' + hotel.hotel_id + ')' : ''),
        );
      }
      if (stay) {
        parts.push(
          stay.check_in +
            ' to ' +
            stay.check_out +
            ', ' +
            stay.nights +
            (stay.nights === 1 ? ' night' : ' nights') +
            ', ' +
            stay.adults +
            (stay.adults === 1 ? ' guest' : ' guests') +
            (stay.children ? ' + ' + stay.children + ' children' : ''),
        );
      }
      if (room && room.name) {
        var price = data.price && data.price.nightly ? formatMoney(data.price.nightly) : null;
        parts.push('viewing ' + room.name + (price ? ' at ' + price + '/night' : ''));
      }
      if (data.verdict && data.verdict.out_of_ten !== null && data.verdict.out_of_ten !== undefined) {
        parts.push('WhataRate! Check scores it ' + formatOutOfTen(data.verdict.out_of_ten) + '/10');
      }
      var premium = data.premium_justification;
      if (premium && premium.premium_pct !== null && premium.premium_pct !== undefined) {
        parts.push('about ' + formatPct(premium.premium_pct) + ' above comparable hotels');
      }
      if (data.hotel_value && data.hotel_value.supporting_signals && data.hotel_value.supporting_signals.length > 0) {
        parts.push('hotel strengths: ' + data.hotel_value.supporting_signals.join(', '));
      }
      var sup = data.superior_alternative;
      if (sup && sup.kind === 'HOTEL' && sup.hotel) {
        parts.push(
          'superior alternative shown: ' +
            sup.hotel.name +
            ' at ' +
            formatMoney(sup.hotel.nightly) +
            '/night',
        );
      } else if (sup && sup.kind === 'ROOM' && sup.room) {
        parts.push('room upgrade shown: ' + sup.room.name);
      }
      if (options && options.preference && options.preference !== 'GENERAL_VALUE') {
        parts.push('what matters most to me: ' + (preferenceLabel(options.preference) || options.preference));
      }
      if (parts.length === 0) return '';
      return parts.join('; ') + '. Can you help me with this stay?';
    } catch (e) {
      return '';
    }
  }

  /**
   * The preference selector (Phase 6). Values are the API's enum; labels are
   * the guest's words. GENERAL_VALUE is the default and means "no
   * personalization" — the widget renders exactly what it rendered before
   * the selector existed.
   */
  var PREFERENCE_OPTIONS = [
    { value: 'GENERAL_VALUE', label: 'General value' },
    { value: 'BEST_VALUE', label: 'Best value' },
    { value: 'LUXURY_EXPERIENCE', label: 'Luxury & experience' },
    { value: 'LOCATION', label: 'Location' },
    { value: 'AMENITIES', label: 'Amenities' },
    { value: 'BEACH_RESORT', label: 'Beach & resort' },
    { value: 'FAMILY', label: 'Family' },
    { value: 'NIGHTLIFE', label: 'Nightlife' },
    { value: 'QUIET_RELAXATION', label: 'Quiet & relaxation' },
    { value: 'BUSINESS_TRAVEL', label: 'Business travel' },
  ];

  function preferenceLabel(value) {
    for (var i = 0; i < PREFERENCE_OPTIONS.length; i++) {
      if (PREFERENCE_OPTIONS[i].value === value) return PREFERENCE_OPTIONS[i].label;
    }
    return null;
  }

  var SCORE_TONE = {
    EXCELLENT: 'wahpi--good',
    GOOD: 'wahpi--good',
    FAIR: 'wahpi--neutral',
    BELOW_AVERAGE: 'wahpi--warn',
    POOR: 'wahpi--bad',
  };
  var SCORE_LABEL = {
    EXCELLENT: 'Excellent rate',
    GOOD: 'Good rate',
    FAIR: 'Typical rate',
    BELOW_AVERAGE: 'Above typical',
    POOR: 'Expensive',
  };
  var CONFIDENCE_LABEL = {
    HIGH: 'High confidence',
    MODERATE: 'Moderate confidence',
    LOW: 'Low confidence',
    INSUFFICIENT: 'Insufficient data',
  };
  var RECOMMENDATION_TONE = {
    BOOK_NOW: 'wahpi--good',
    CONSIDER: 'wahpi--neutral',
    INSUFFICIENT_DATA: 'wahpi--neutral',
  };
  /** What the price did — independent of whether it helps the customer. */
  var REASON_MARK = {
    BELOW_HISTORICAL_AVERAGE: '↓',
    NEAR_HISTORICAL_LOW: '↓',
    NEW_LOW: '↓',
    BELOW_COMPARABLE_HOTELS: '↓',
    LOW_SEASON: '↓',
    ABOVE_HISTORICAL_AVERAGE: '↑',
    NEAR_HISTORICAL_HIGH: '↑',
    ABOVE_COMPARABLE_HOTELS: '↑',
    PEAK_SEASON: '↑',
    PRICE_RISING_7D: '↗',
    PRICE_FALLING_7D: '↘',
    EVENT_DRIVEN_DEMAND: '◆',
    HIGH_DEMAND_RATE_STILL_LOW: '◆',
    LIMITED_AVAILABILITY: '◆',
    BENEFITS_INCLUDED: '✓',
  };

  var RECOMMENDATION_SUB = {
    G2: 'This rate is well below typical for this room.',
    G3: 'This rate is good and has been rising.',
    G4: 'This rate is above typical and has not been rising.',
    G5: 'This rate is about normal for this room.',
    G0: "We're still building price history for this room.",
  };

  // ── sections ───────────────────────────────────────────────────────────

  function renderSubject(data) {
    var wrap = section(null);
    wrap.appendChild(el('h2', null, data.subject.hotel.name));

    var stay = data.subject.stay;
    // The room category appears exactly once, in its concise form. Repeating
    // the full source name in an "auto-selected" footnote said the same thing
    // twice, the second time with the amenity list attached.
    var meta =
      conciseRoomName(data.subject.room_type.name) +
      ' · ' +
      formatStayDates(stay.check_in, stay.check_out) +
      ' · ' +
      stay.nights +
      (stay.nights === 1 ? ' night' : ' nights') +
      ' · ' +
      stay.adults +
      (stay.adults === 1 ? ' guest' : ' guests');
    wrap.appendChild(el('div', 'wahpi__subject-meta', meta));

    // Mandatory, not optional detail: the customer must be able to see which
    // product was assessed, or the assessment may not apply to what they book.
    wrap.appendChild(el('span', 'wahpi__terms', data.subject.rate_plan.summary));
    return wrap;
  }

  function formatStayDates(checkIn, checkOut) {
    var opts = { month: 'short', day: 'numeric' };
    var a = new Date(checkIn + 'T00:00:00Z').toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
    var b = new Date(checkOut + 'T00:00:00Z').toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
    void opts;
    return a + '–' + b;
  }

  function renderPrice(data) {
    var wrap = section(null);
    var row = el('div', 'wahpi__price');
    row.appendChild(el('span', 'wahpi__price-nightly', formatMoney(data.price.nightly)));
    row.appendChild(el('span', 'wahpi__price-unit', 'per night'));
    row.appendChild(
      el(
        'span',
        'wahpi__price-total',
        '· ' + formatMoney(data.price.total) + ' total for ' + data.subject.stay.nights + ' nights',
      ),
    );
    wrap.appendChild(row);

    // Rule: tax basis explicit, never ambiguous — and the nightly rate and the
    // stay total do not share one. See renderLivePrice for the reasoning.
    wrap.appendChild(el('div', 'wahpi__tax', taxLabel(data.price)));

    if (data.price.effective_nightly && data.price.benefit_value_per_night.amount_minor > 0) {
      wrap.appendChild(
        el(
          'div',
          'wahpi__effective',
          'Effective ' +
            formatMoney(data.price.effective_nightly) +
            ' per night after ' +
            formatMoney(data.price.benefit_value_per_night) +
            ' of included benefits.',
        ),
      );
    }
    return wrap;
  }

  function renderVerdict(data) {
    var v = data.verdict;
    var wrap = section(null);
    var grid = el('div', 'wahpi__verdict');

    // Deal Score. Decision D4: at LOW confidence show the band only — a precise
    // "83" invites more trust than the evidence supports.
    var scoreBox = el('div', 'wahpi__metric');
    scoreBox.appendChild(el('div', 'wahpi__metric-label', 'Deal score'));
    var bandOnly = v.confidence_band === 'LOW';

    if (v.deal_score === null || v.deal_score === undefined) {
      // Rule 2: never 0 for an absent score.
      var none = el('div', 'wahpi__metric-value wahpi__metric-value--band-only', 'Not available');
      scoreBox.appendChild(none);
    } else if (bandOnly) {
      var band = el(
        'div',
        'wahpi__metric-value wahpi__metric-value--band-only ' + SCORE_TONE[v.deal_score_band],
        SCORE_LABEL[v.deal_score_band],
      );
      scoreBox.appendChild(band);
      scoreBox.appendChild(
        el('div', 'wahpi__metric-note', 'Shown as a range because our confidence is low.'),
      );
    } else {
      var value = el('div', 'wahpi__metric-value ' + SCORE_TONE[v.deal_score_band]);
      value.textContent = v.deal_score;
      var outOf = el('span', 'wahpi__metric-sub', ' / 100');
      value.appendChild(outOf);
      scoreBox.appendChild(value);
      scoreBox.appendChild(
        el(
          'div',
          'wahpi__metric-sub ' + SCORE_TONE[v.deal_score_band],
          SCORE_LABEL[v.deal_score_band],
        ),
      );
    }
    grid.appendChild(scoreBox);

    // Confidence — same visual weight as the score. Rule 1.
    var confBox = el('div', 'wahpi__metric');
    confBox.appendChild(el('div', 'wahpi__metric-label', 'Confidence'));
    var confValue = el('div', 'wahpi__metric-value');
    confValue.textContent = v.confidence;
    confValue.appendChild(el('span', 'wahpi__metric-sub', ' / 100'));
    confBox.appendChild(confValue);
    confBox.appendChild(el('div', 'wahpi__metric-sub', CONFIDENCE_LABEL[v.confidence_band]));
    confBox.appendChild(
      el(
        'div',
        'wahpi__metric-note',
        'How much price history we have for this exact room and dates.',
      ),
    );
    grid.appendChild(confBox);

    var recBox = el('div', 'wahpi__recommendation ' + RECOMMENDATION_TONE[v.recommendation]);
    recBox.appendChild(el('div', 'wahpi__recommendation-label', v.recommendation_label));
    recBox.appendChild(
      el('div', 'wahpi__recommendation-sub', RECOMMENDATION_SUB[v.gate_fired] || ''),
    );
    grid.appendChild(recBox);

    wrap.appendChild(grid);
    return wrap;
  }

  function renderExplanation(data) {
    if (!data.explanation || !data.explanation.text) return null;
    var wrap = section(null);
    wrap.appendChild(el('p', 'wahpi__explanation', data.explanation.text));
    return wrap;
  }

  function renderReasons(data) {
    if (!data.reasons || data.reasons.length === 0) return null;
    var wrap = section('Why');
    var list = el('ul', 'wahpi__reasons');

    data.reasons.forEach(function (reason) {
      var item = el('li', 'wahpi__reason');
      var positive = reason.direction === 'POSITIVE';
      // The MARK describes what the price did; the COLOUR describes whether
      // that is good for the customer. Conflating them (a green ↓ on "the rate
      // has increased") reads as a contradiction.
      var mark = el(
        'span',
        'wahpi__reason-mark ' + (positive ? 'wahpi--good' : 'wahpi--warn'),
        REASON_MARK[reason.code] || (positive ? '↓' : '↑'),
      );
      item.appendChild(mark);
      item.appendChild(el('span', null, reason.text));
      list.appendChild(item);
    });

    wrap.appendChild(list);
    return wrap;
  }

  // ── history chart ──────────────────────────────────────────────────────

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (key) {
      node.setAttribute(key, attrs[key]);
    });
    return node;
  }

  function renderHistory(data, windowDays, onWindowChange) {
    if (!data.history || !data.history.series || data.history.series.length < 2) return null;

    var wrap = section('Price history');

    var controls = el('div', 'wahpi__chart-controls');
    [30, 60, 90].forEach(function (days) {
      var btn = el('button', 'wahpi__chart-btn', days + ' days');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(days === windowDays));
      btn.addEventListener('click', function () {
        onWindowChange(days);
      });
      controls.appendChild(btn);
    });
    wrap.appendChild(controls);

    var cutoff = Date.now() - windowDays * 86400000;
    var points = data.history.series.filter(function (p) {
      return Date.parse(p.date + 'T00:00:00Z') >= cutoff;
    });
    if (points.length < 2) points = data.history.series.slice(-2);

    var width = 640;
    var height = 168;
    var padding = { top: 12, right: 12, bottom: 22, left: 52 };

    var values = points.map(function (p) {
      return p.nightly_minor;
    });
    var reference = data.history.reference || {};
    [reference.typical, reference.p10, reference.p90].forEach(function (m) {
      if (m && m.amount_minor) values.push(m.amount_minor);
    });

    var minValue = Math.min.apply(null, values);
    var maxValue = Math.max.apply(null, values);
    var span = maxValue - minValue || 1;
    minValue -= span * 0.08;
    maxValue += span * 0.08;

    var times = points.map(function (p) {
      return Date.parse(p.date + 'T00:00:00Z');
    });
    var minTime = Math.min.apply(null, times);
    var maxTime = Math.max.apply(null, times);
    var timeSpan = maxTime - minTime || 1;

    function x(t) {
      return padding.left + ((t - minTime) / timeSpan) * (width - padding.left - padding.right);
    }
    function y(v) {
      return (
        padding.top +
        (1 - (v - minValue) / (maxValue - minValue)) * (height - padding.top - padding.bottom)
      );
    }

    var svg = svgEl('svg', {
      class: 'wahpi__chart',
      viewBox: '0 0 ' + width + ' ' + height,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': chartSummary(data, points),
    });

    // p10–p90 band, so "normal range" is visible rather than implied.
    if (reference.p10 && reference.p90) {
      var bandTop = y(reference.p90.amount_minor);
      var bandBottom = y(reference.p10.amount_minor);
      svg.appendChild(
        svgEl('rect', {
          x: padding.left,
          y: Math.min(bandTop, bandBottom),
          width: width - padding.left - padding.right,
          height: Math.abs(bandBottom - bandTop),
          fill: '#0b5cad',
          'fill-opacity': '0.07',
        }),
      );
    }

    if (reference.typical) {
      var ty = y(reference.typical.amount_minor);
      svg.appendChild(
        svgEl('line', {
          x1: padding.left,
          x2: width - padding.right,
          y1: ty,
          y2: ty,
          stroke: '#5b6270',
          'stroke-dasharray': '4 4',
          'stroke-width': '1',
        }),
      );
      var label = svgEl('text', {
        x: padding.left - 6,
        y: ty + 4,
        'text-anchor': 'end',
        'font-size': '10',
        fill: '#5b6270',
      });
      label.textContent = 'typical';
      svg.appendChild(label);
    }

    // Gaps break the line. Interpolating across unobserved days would be
    // fabricated history (docs/mvp/08 §3F).
    var gapMs = 2.5 * 86400000;
    var run = [];
    var runs = [];
    points.forEach(function (p, i) {
      var t = Date.parse(p.date + 'T00:00:00Z');
      if (i > 0 && t - Date.parse(points[i - 1].date + 'T00:00:00Z') > gapMs) {
        runs.push(run);
        run = [];
      }
      run.push({ t: t, v: p.nightly_minor });
    });
    runs.push(run);

    runs.forEach(function (segment) {
      if (segment.length === 1) {
        svg.appendChild(
          svgEl('circle', { cx: x(segment[0].t), cy: y(segment[0].v), r: 2.5, fill: '#0b5cad' }),
        );
        return;
      }
      var d = segment
        .map(function (pt, i) {
          return (i === 0 ? 'M' : 'L') + x(pt.t).toFixed(1) + ' ' + y(pt.v).toFixed(1);
        })
        .join(' ');
      svg.appendChild(
        svgEl('path', {
          d: d,
          fill: 'none',
          stroke: '#0b5cad',
          'stroke-width': '2',
          'stroke-linejoin': 'round',
        }),
      );
    });

    var last = points[points.length - 1];
    svg.appendChild(
      svgEl('circle', {
        cx: x(Date.parse(last.date + 'T00:00:00Z')),
        cy: y(last.nightly_minor),
        r: 4.5,
        fill: '#0b5cad',
        stroke: '#fff',
        'stroke-width': '2',
      }),
    );

    [minValue, maxValue].forEach(function (v) {
      var t = svgEl('text', {
        x: padding.left - 6,
        y: y(v) + 4,
        'text-anchor': 'end',
        'font-size': '10',
        fill: '#5b6270',
      });
      t.textContent = formatMoney({ amount_minor: v, currency: currencyOf(data) });
      svg.appendChild(t);
    });

    wrap.appendChild(svg);
    wrap.appendChild(el('div', 'wahpi__chart-summary', chartSummary(data, points)));

    if (data.history.gaps && data.history.gaps.length > 0) {
      wrap.appendChild(
        el(
          'div',
          'wahpi__chart-summary',
          'Breaks in the line are periods we did not record a rate.',
        ),
      );
    }

    // The chart must never be the sole carrier of information.
    var toggle = el('button', 'wahpi__table-toggle', 'Show as a table');
    toggle.type = 'button';
    var table = buildTable(points, currencyOf(data));
    table.hidden = true;
    toggle.addEventListener('click', function () {
      table.hidden = !table.hidden;
      toggle.textContent = table.hidden ? 'Show as a table' : 'Hide table';
    });
    wrap.appendChild(toggle);
    wrap.appendChild(table);

    return wrap;
  }

  function currencyOf(data) {
    return (data.price && data.price.nightly && data.price.nightly.currency) || 'USD';
  }

  function chartSummary(data, points) {
    var first = points[0].nightly_minor;
    var last = points[points.length - 1].nightly_minor;
    var change = ((last - first) / first) * 100;
    var direction = change > 0.5 ? 'risen' : change < -0.5 ? 'fallen' : 'held steady';
    if (direction === 'held steady') {
      return (
        'Over the period shown, the rate has held steady around ' +
        formatMoney({ amount_minor: last, currency: currencyOf(data) }) +
        '.'
      );
    }
    return (
      'Over the period shown, the rate has ' +
      direction +
      ' ' +
      formatPct(change) +
      ', from ' +
      formatMoney({ amount_minor: first, currency: currencyOf(data) }) +
      ' to ' +
      formatMoney({ amount_minor: last, currency: currencyOf(data) }) +
      '.'
    );
  }

  function buildTable(points, currency) {
    var table = el('table', 'wahpi__table');
    var thead = el('thead');
    var headRow = el('tr');
    headRow.appendChild(el('th', null, 'Date observed'));
    headRow.appendChild(el('th', null, 'Nightly rate'));
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    points.forEach(function (p) {
      var row = el('tr');
      row.appendChild(el('td', null, p.date));
      row.appendChild(
        el('td', null, formatMoney({ amount_minor: p.nightly_minor, currency: currency })),
      );
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    return table;
  }

  function renderStats(data) {
    var b = data.baseline;
    if (!b || b.typical_nightly === null) return null;

    var wrap = section('How this compares');
    var grid = el('div', 'wahpi__stats');

    function stat(label, value) {
      var box = el('div');
      box.appendChild(el('div', 'wahpi__stat-label', label));
      box.appendChild(el('div', 'wahpi__stat-value', value));
      grid.appendChild(box);
    }

    // "Typical", not "average": we display the median, which is more robust to
    // the fat tails hotel rates actually have (docs/mvp/01 §6).
    stat('Typical rate (' + b.lookback_days + ' days)', formatMoney(b.typical_nightly));
    stat('Lowest observed', formatMoney(b.lowest_observed));
    stat('Highest observed', formatMoney(b.highest_observed));
    if (b.percentile_rank !== null && b.percentile_rank !== undefined) {
      stat('This rate ranks', 'Cheaper than ' + (100 - b.percentile_rank) + '% of observed rates');
    }

    wrap.appendChild(grid);
    return wrap;
  }

  function renderProvenance(data) {
    var wrap = section(null);
    var b = data.baseline;

    var lines = [];
    var observed = el('span');
    observed.textContent = 'Rate observed ' + relativeTime(data.data_as_of);
    observed.title = new Date(data.data_as_of).toISOString();
    lines.push(observed);

    var basis = el('div');
    basis.textContent =
      b && b.n_observations
        ? 'Based on ' + b.n_observations + ' recorded rates over ' + b.lookback_days + ' days.'
        : 'No recorded rate history for this room yet.';
    lines.push(basis);

    var provenance = el('div', 'wahpi__provenance');
    provenance.appendChild(observed);
    provenance.appendChild(basis);
    wrap.appendChild(provenance);

    if (data.caveats && data.caveats.length > 0) {
      var list = el('ul', 'wahpi__caveats');
      data.caveats.forEach(function (c) {
        list.appendChild(el('li', 'wahpi__caveat', c.text));
      });
      wrap.appendChild(list);
    }
    return wrap;
  }

  /**
   * The two calls to action, in deliberate hierarchy: BOOK THIS RATE is the
   * primary act, GET HELP the safety net beside it.
   *
   * The booking link comes from the API's `booking` block — the source's own
   * room and rate codes for the EXACT rate on screen — so the booking page
   * opens on the rate the widget scored. A host-page `bookingUrl` option
   * still wins when supplied. With neither, the button is disabled and says
   * so; a guessed URL is never built.
   */
  function renderActions(data, options) {
    var wrap = section(null);
    var actions = el('div', 'wahpi__actions');

    var bookUrl = options.bookingUrl || (data.booking && data.booking.url) || null;
    var book = el('a', 'wahpi__btn wahpi__btn--primary', 'Book this rate');
    if (bookUrl) {
      book.href = bookUrl;
    } else {
      book.href = '#';
      book.className = 'wahpi__btn wahpi__btn--disabled';
      book.setAttribute('aria-disabled', 'true');
      book.addEventListener('click', function (e) {
        e.preventDefault();
      });
      book.title = 'Booking information is temporarily unavailable.';
    }
    actions.appendChild(book);

    var help = el('button', 'wahpi__btn wahpi__btn--secondary', 'Get help');
    help.type = 'button';
    help.addEventListener('click', function () {
      var chatId = options.helpChatId || VIBSS_DEFAULT_ID;
      help.disabled = true;
      ensureVibss(chatId, function (ok) {
        help.disabled = false;
        if (ok) openVibss(chatId, helpContext(data, options));
        else explain('warn', 'the chat widget could not be loaded');
      });
    });
    actions.appendChild(help);

    wrap.appendChild(actions);
    if (!bookUrl) {
      wrap.appendChild(
        el('div', 'wahpi__actions-note', 'Booking information is temporarily unavailable.'),
      );
    }
    return wrap;
  }

  // ── the live-market model ──────────────────────────────────────────────

  var LIVE_BAND_TONE = {
    EXCEPTIONAL: 'wahpi--good',
    STRONG: 'wahpi--good',
    MARKET: 'wahpi--neutral',
    PREMIUM: 'wahpi--warn',
  };

  var LIVE_VERDICT_TONE = {
    BOOK_NOW: 'wahpi--good',
    BOOK_CONSIDER: 'wahpi--neutral',
    CONSIDER_ALTERNATIVES: 'wahpi--warn',
    NOT_ENOUGH_DATA: 'wahpi--neutral',
  };

  var LIVE_CONFIDENCE_NOTE = {
    HIGH: 'Based on a full comp set and nearby dates, all live-checked.',
    MEDIUM: 'Based on a partial comp set. Treat the figure as indicative.',
    LOW: 'Thin evidence — too few live competitor rates to be certain.',
  };

  var SIGNAL_UNAVAILABLE = {
    NO_SUBJECT_RATE: 'No live rate for this room.',
    INSUFFICIENT_COMPARABLES: 'Too few competitors with a live rate for these dates.',
    INSUFFICIENT_NEIGHBOURS: 'Too few nearby dates priced for this room.',
    NO_AVAILABILITY_DATA: 'We have not checked enough of the comp set for these dates.',
  };

  /** Rule 5, applied to the customer-facing figure: always one decimal. */
  function formatOutOfTen(value) {
    return value === null || value === undefined ? '—' : Number(value).toFixed(1);
  }

  /**
   * The room-category chooser.
   *
   * Rendered only when the stay actually has more than one bookable room — a
   * single-option <select> is a control that cannot be used, and it implies a
   * choice the guest does not have.
   *
   * Changing it RE-REQUESTS with `room_type_id` rather than re-labelling what
   * is on screen. The comp set, the nearby-date series and the terms match are
   * all keyed on the chosen room, so a different category is a different
   * question with a different answer — not the same score under a new name.
   */
  function renderRoomPicker(data, state) {
    // A category pinned by the host page's own per-row button (room_code)
    // must not be re-choosable inside the panel — the page IS the chooser.
    if (state.options.roomCode) return null;
    var options = data.subject.room_options || [];
    if (options.length < 2 || typeof state.onRoomChange !== 'function') return null;

    var wrap = el('div', 'wahpi__room-picker');
    var id = 'wahpi-room-' + state.uid;

    var label = el('label', 'wahpi__room-label', 'Room category');
    label.setAttribute('for', id);
    wrap.appendChild(label);

    var select = document.createElement('select');
    select.className = 'wahpi__room-select';
    select.id = id;

    for (var i = 0; i < options.length; i += 1) {
      var option = options[i];
      var node = document.createElement('option');
      node.value = option.room_type_id;
      // The price belongs in the label: choosing a category IS a price
      // decision, and making the guest select each one to discover the cost
      // turns a comparison into a scavenger hunt.
      node.textContent = conciseRoomName(option.name) + ' — ' + formatMoney(option.nightly) + '/night';
      if (option.room_type_id === data.subject.room_type.room_type_id) node.selected = true;
      select.appendChild(node);
    }

    select.addEventListener('change', function () {
      state.onRoomChange(select.value);
    });
    wrap.appendChild(select);
    return wrap;
  }

  /**
   * "What matters most to you?" — the preference chips.
   *
   * Picking one RE-REQUESTS with `preference` rather than re-labelling
   * what is on screen, exactly like the room picker: the personalized
   * sections are written and validated server-side, and the widget never
   * assembles personalized prose from numbers. The choice is fully
   * reversible — General value restores the un-personalized answer — and
   * it survives a room-category change, because a preference belongs to
   * the guest, not to the room.
   */
  function renderPreferencePicker(data, state) {
    if (typeof state.onPreferenceChange !== 'function') return null;
    var current = state.options.preference || 'GENERAL_VALUE';

    var wrap = el('div', 'wahpi__pref');
    wrap.appendChild(el('div', 'wahpi__pref-label', 'What matters most to you?'));

    var row = el('div', 'wahpi__pref-chips');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'What matters most to you?');
    PREFERENCE_OPTIONS.forEach(function (option) {
      var chip = el(
        'button',
        'wahpi__pref-chip' + (option.value === current ? ' wahpi__pref-chip--active' : ''),
        option.label,
      );
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(option.value === current));
      chip.addEventListener('click', function () {
        if (option.value !== current) state.onPreferenceChange(option.value);
      });
      row.appendChild(chip);
    });
    wrap.appendChild(row);
    return wrap;
  }

  /**
   * The personalized reading — the SAME facts, through the guest's stated
   * preference. Absent (General value, or the API produced none), nothing
   * renders and the panel is exactly its un-personalized self.
   *
   * Every sentence here was written and validated server-side. The widget
   * renders it verbatim: no assembly, no additions, no reordering.
   */
  function renderLivePersonalization(data) {
    var p = data.personalization;
    if (!p || !p.personalized_insight) return null;

    var wrap = section(null);
    var box = el('div', 'wahpi__personal');
    var label = preferenceLabel(p.preference);
    box.appendChild(
      el('div', 'wahpi__premium-eyebrow', 'FOR YOUR PRIORITIES' + (label ? ' — ' + label : '')),
    );
    box.appendChild(el('div', 'wahpi__personal-insight', p.personalized_insight));

    if (p.why_this_hotel_may_fit && p.why_this_hotel_may_fit.length > 0) {
      box.appendChild(el('div', 'wahpi__premium-subhead', 'WHY THIS HOTEL MAY FIT YOU'));
      var fit = el('ul', 'wahpi__personal-list');
      p.why_this_hotel_may_fit.forEach(function (text) {
        var item = el('li', 'wahpi__personal-item');
        item.appendChild(el('span', 'wahpi__personal-mark wahpi--good', '✓'));
        item.appendChild(el('span', 'wahpi__personal-text', text));
        fit.appendChild(item);
      });
      box.appendChild(fit);
    }

    if (p.what_to_consider && p.what_to_consider.length > 0) {
      box.appendChild(el('div', 'wahpi__premium-subhead', 'WHAT TO CONSIDER'));
      var consider = el('ul', 'wahpi__personal-list');
      p.what_to_consider.forEach(function (text) {
        var item = el('li', 'wahpi__personal-item');
        item.appendChild(el('span', 'wahpi__personal-mark wahpi--neutral', '•'));
        item.appendChild(el('span', 'wahpi__personal-text', text));
        consider.appendChild(item);
      });
      box.appendChild(consider);
    }

    box.appendChild(
      el(
        'div',
        'wahpi__premium-confidence',
        'Tailored view — the score and prices above do not change with your preference.',
      ),
    );
    wrap.appendChild(box);
    return wrap;
  }

  /**
   * The rate-plan chooser, rendered only when the chosen room genuinely has
   * more than one bookable offer. Same contract as the room picker: picking
   * a rate RE-REQUESTS with `rate_id` — the terms match, the comp set, the
   * score and the booking link all key on the chosen plan, so a different
   * offer is a different question with a different answer.
   */
  function renderRatePicker(data, state) {
    if (state.options.roomCode) return null;
    var options = data.subject.rate_options || [];
    if (options.length < 2 || typeof state.onRateChange !== 'function') return null;

    var wrap = el('div', 'wahpi__rate-picker');
    wrap.appendChild(el('div', 'wahpi__room-label', 'Rate'));
    var group = el('div', 'wahpi__rate-options');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Rate');

    options.forEach(function (option) {
      var active = option.rate_id === data.subject.selected_rate_id;
      var row = el('button', 'wahpi__rate-option' + (active ? ' wahpi__rate-option--active' : ''));
      row.type = 'button';
      row.setAttribute('role', 'radio');
      row.setAttribute('aria-checked', String(active));
      var label = el('span', 'wahpi__rate-name', option.name);
      row.appendChild(label);
      row.appendChild(el('span', 'wahpi__rate-price', formatMoney(option.nightly) + '/night'));
      row.addEventListener('click', function () {
        if (!active) state.onRateChange(option.rate_id);
      });
      group.appendChild(row);
    });

    wrap.appendChild(group);
    return wrap;
  }

  function renderLiveSubject(data) {
    var wrap = section(null);
    wrap.appendChild(el('h2', null, data.subject.hotel.name));

    // The room appears here ONCE, as category + bedding. It used to appear
    // three times (meta, the auto-room line, the picker), which read as
    // noise; the picker labels remain because they are the choices.
    var stay = data.subject.stay;
    wrap.appendChild(
      el(
        'div',
        'wahpi__subject-meta',
        conciseRoomName(data.subject.room_type.name) +
          ' · ' +
          formatStayDates(stay.check_in, stay.check_out) +
          ' · ' +
          stay.nights +
          (stay.nights === 1 ? ' night' : ' nights') +
          ' · ' +
          stay.adults +
          (stay.adults === 1 ? ' guest' : ' guests'),
      ),
    );

    // Mandatory, not optional detail: the customer must be able to see which
    // product was assessed, or the assessment may not apply to what they book.
    wrap.appendChild(el('span', 'wahpi__terms', data.subject.rate_plan.summary));
    return wrap;
  }

  function renderLivePrice(data) {
    var wrap = section(null);
    var row = el('div', 'wahpi__price');
    row.appendChild(el('span', 'wahpi__price-nightly', formatMoney(data.price.nightly)));
    row.appendChild(el('span', 'wahpi__price-unit', 'per night'));
    row.appendChild(
      el(
        'span',
        'wahpi__price-total',
        '· ' +
          formatMoney(data.price.total) +
          ' total for ' +
          data.subject.stay.nights +
          (data.subject.stay.nights === 1 ? ' night' : ' nights'),
      ),
    );
    wrap.appendChild(row);

    // Rule: tax basis explicit, never ambiguous — and the two figures above do
    // NOT share a basis. The nightly rate is the base room rate (the same way
    // whatahotel.com quotes a night); the total is what the stay actually
    // costs, taxes and fees included. One label describing both would be
    // wrong about one of them.
    wrap.appendChild(el('div', 'wahpi__tax', taxLabel(data.price)));
    return wrap;
  }

  /**
   * The headline: 8.7 / 10 — STRONG VALUE — BOOK NOW.
   *
   * Rule 1 still holds, and matters more here than in the history model: the
   * score is a single figure with no visible margin, so the confidence word
   * sits beside it at the same visual weight rather than below the fold. A
   * MEDIUM-confidence 8.7 and a HIGH-confidence 8.7 are different products.
   *
   * Rule 2 also holds: an unmeasurable stay renders "Not available", never 0.0.
   */
  function renderLiveVerdict(data) {
    var v = data.verdict;
    var wrap = section(null);
    var grid = el('div', 'wahpi__verdict');

    var tone = v.band ? LIVE_BAND_TONE[v.band] : 'wahpi--neutral';

    var scoreBox = el('div', 'wahpi__metric');
    scoreBox.appendChild(el('div', 'wahpi__metric-label', 'Deal score'));

    if (v.out_of_ten === null || v.out_of_ten === undefined) {
      scoreBox.appendChild(
        el('div', 'wahpi__metric-value wahpi__metric-value--band-only', 'Not available'),
      );
      scoreBox.appendChild(
        el('div', 'wahpi__metric-note', 'Not enough live rates to score this stay.'),
      );
    } else {
      var value = el('div', 'wahpi__metric-value wahpi__live-score ' + tone);
      value.textContent = formatOutOfTen(v.out_of_ten);
      value.appendChild(el('span', 'wahpi__metric-sub', ' / 10'));
      scoreBox.appendChild(value);
      scoreBox.appendChild(el('div', 'wahpi__metric-sub ' + tone, v.band_label));
    }
    grid.appendChild(scoreBox);

    var confBox = el('div', 'wahpi__metric');
    confBox.appendChild(el('div', 'wahpi__metric-label', 'Confidence'));
    confBox.appendChild(el('div', 'wahpi__metric-value wahpi__live-confidence', v.confidence));
    confBox.appendChild(el('div', 'wahpi__metric-note', LIVE_CONFIDENCE_NOTE[v.confidence] || ''));
    grid.appendChild(confBox);

    // No sub-line: the old one restated the explanation that renders just
    // below. The space now belongs to WHY YOU MIGHT CHOOSE THIS HOTEL.
    var recBox = el('div', 'wahpi__recommendation ' + LIVE_VERDICT_TONE[v.verdict]);
    recBox.appendChild(el('div', 'wahpi__recommendation-label', v.verdict_label));
    grid.appendChild(recBox);

    wrap.appendChild(grid);
    return wrap;
  }

  /**
   * WHY YOU MIGHT CHOOSE THIS HOTEL (Phase 6.X).
   *
   * The other half of the decision, rendered verbatim from the validated
   * server response: what is attractive about this property, from evidence
   * only. The supporting chips are code-built signals — a rating, review
   * themes, the source's own perks — never marketing badges. Absent
   * evidence means the API sent null and nothing renders here.
   */
  function renderLiveWhyChoose(data) {
    var hv = data.hotel_value;
    if (!hv || !hv.summary) return null;

    var wrap = section(null);
    var box = el('div', 'wahpi__why');
    box.appendChild(el('div', 'wahpi__premium-eyebrow', 'WHY YOU MIGHT CHOOSE THIS HOTEL'));
    if (hv.headline) box.appendChild(el('div', 'wahpi__why-headline', hv.headline));
    box.appendChild(el('div', 'wahpi__why-text', hv.summary));
    if (hv.supporting_signals && hv.supporting_signals.length > 0) {
      var chips = el('div', 'wahpi__why-signals');
      hv.supporting_signals.forEach(function (signal) {
        chips.appendChild(el('span', 'wahpi__why-signal', signal));
      });
      box.appendChild(chips);
    }
    wrap.appendChild(box);
    return wrap;
  }

  /**
   * The sentences the API wrote, verbatim.
   *
   * The widget does NOT assemble prose from numbers. Every sentence here was
   * produced server-side from an already-computed fact bundle and, when a
   * language model wrote it, validated against that bundle's numeric
   * allowlist before it left the server. Rewriting any of it in the browser
   * would put unvalidated text on the page.
   */
  function renderLiveExplanation(data) {
    var explanation = data.explanation;
    if (!explanation || !explanation.text) return null;
    var wrap = section(null);
    wrap.appendChild(el('p', 'wahpi__summary', explanation.text));
    return wrap;
  }

  /**
   * Is the extra money buying anything?
   *
   * Its own block, next to the score rather than inside it: a hotel can be
   * expensive and still the right choice, and collapsing those two questions
   * into one number is how "costs more" becomes "is worse".
   *
   * LIMITED_DATA is rendered as limited data, never as a soft yes.
   */
  function renderLivePremium(data) {
    var premium = data.premium_justification;
    if (!premium || premium.level === 'NOT_PREMIUM') return null;

    // The reasoned verdict, when the API produced one. Everything shown here
    // was validated server-side — the widget renders it verbatim and adds
    // nothing. Without an assessment, the deterministic summary stands.
    var assessment = premium.assessment;
    var wrap = section(null);
    var box;
    if (assessment) {
      var frame = assessment.position;
      box = el('div', 'wahpi__premium ' + (POSITION_TONE[frame] || 'wahpi--neutral'));
      box.appendChild(el('div', 'wahpi__premium-eyebrow', 'PREMIUM INSIGHT'));
      box.appendChild(
        el('div', 'wahpi__premium-label', POSITION_LABEL[frame] || 'Premium pricing'),
      );
      box.appendChild(el('div', 'wahpi__premium-text', assessment.reasoning));
      if (assessment.availability_context) {
        box.appendChild(el('div', 'wahpi__premium-availability', assessment.availability_context));
      }
      if (assessment.paying_more_for) {
        box.appendChild(el('div', 'wahpi__premium-subhead', "WHAT YOU'RE PAYING MORE FOR"));
        box.appendChild(el('div', 'wahpi__premium-text', assessment.paying_more_for));
      }
      box.appendChild(
        el(
          'div',
          'wahpi__premium-confidence',
          'Confidence: ' +
            assessment.confidence +
            ' · based on ' +
            (data.signals && data.signals.comp_set ? data.signals.comp_set.comps_used : 0) +
            ' comparable hotel(s)' +
            (data.reputation ? ' and verified guest ratings' : ', no verified guest rating'),
        ),
      );
    } else {
      box = el('div', 'wahpi__premium ' + (PREMIUM_TONE[premium.level] || 'wahpi--neutral'));
      box.appendChild(
        el('div', 'wahpi__premium-label', PREMIUM_LABEL[premium.level] || 'Premium pricing'),
      );
      box.appendChild(el('div', 'wahpi__premium-text', premium.summary));
    }
    wrap.appendChild(box);
    return wrap;
  }

  /**
   * SUPERIOR ALTERNATIVE — the upsell, never the downsell.
   *
   * Either a comparable hotel rated meaningfully ABOVE this one by verified
   * guests (with a direct link to its page), or — when no hotel clears the
   * bar, and always when the guest is booking a protected brand — the room
   * upgrade at the SAME property, which deepens the booking instead of
   * competing with it. The tone is "you already have a good option; here is
   * the step up", and every claim was composed server-side from verified
   * evidence. Absent, nothing renders.
   */
  function renderSuperiorAlternative(data, state) {
    var sup = data.superior_alternative;
    if (!sup) return null;

    var wrap = section(null);
    var box = el('div', 'wahpi__alternative');

    if (sup.kind === 'HOTEL' && sup.hotel) {
      var hotel = sup.hotel;
      box.appendChild(el('div', 'wahpi__premium-eyebrow', 'SUPERIOR ALTERNATIVE'));
      var head = el('div', 'wahpi__alternative-head');
      if (hotel.url) {
        var link = el('a', 'wahpi__alternative-name wahpi__alternative-link', hotel.name);
        link.href = hotel.url;
        link.target = '_blank';
        link.rel = 'noopener';
        head.appendChild(link);
      } else {
        head.appendChild(el('span', 'wahpi__alternative-name', hotel.name));
      }
      head.appendChild(el('span', 'wahpi__alternative-price', formatMoney(hotel.nightly) + '/night'));
      box.appendChild(head);

      if (hotel.rating !== null && hotel.rating !== undefined) {
        var ratingRow = el('div', 'wahpi__alternative-rating');
        ratingRow.appendChild(el('span', null, 'Google rating'));
        ratingRow.appendChild(el('span', 'wahpi__reputation-sep', '·'));
        ratingRow.appendChild(renderStars(hotel.rating));
        ratingRow.appendChild(el('span', null, hotel.rating.toFixed(1)));
        if (hotel.review_count) {
          ratingRow.appendChild(el('span', 'wahpi__reputation-sep', '·'));
          ratingRow.appendChild(el('span', null, hotel.review_count.toLocaleString() + ' reviews'));
        }
        box.appendChild(ratingRow);
      }
      if (sup.reason) box.appendChild(el('div', 'wahpi__alternative-reason', sup.reason));
      // No price-comparison line here. The server guarantees an upsell is
      // never cheaper than the booking (the price floor in
      // chooseSuperiorAlternative), and a "less per night" pitch on a
      // step-up card read as a contradiction.
    } else if (sup.kind === 'ROOM' && sup.room) {
      var room = sup.room;
      box.appendChild(el('div', 'wahpi__premium-eyebrow', 'CONSIDER THE UPGRADE'));
      var roomHead = el('div', 'wahpi__alternative-head');
      roomHead.appendChild(el('span', 'wahpi__alternative-name', conciseRoomName(room.name)));
      roomHead.appendChild(el('span', 'wahpi__alternative-price', formatMoney(room.nightly) + '/night'));
      box.appendChild(roomHead);
      if (sup.reason) box.appendChild(el('div', 'wahpi__alternative-reason', sup.reason));
      if (typeof state.onRoomChange === 'function' && !state.options.roomCode) {
        var view = el(
          'button',
          'wahpi__btn wahpi__btn--secondary wahpi__alternative-view',
          'View this room',
        );
        view.type = 'button';
        view.addEventListener('click', function () {
          state.onRoomChange(room.room_type_id);
        });
        box.appendChild(view);
      }
    } else {
      return null;
    }

    wrap.appendChild(box);
    return wrap;
  }

  /**
   * A row of five small stars whose FILL tracks the actual rating — 4.3
   * paints four full stars and 30% of the fifth, never a flat five. Each
   * cell is a muted base star with a width-clipped overlay, so any fraction
   * (half-stars included) renders exactly, with plain text glyphs and no
   * images. The row is decoration: it is aria-hidden inside a container
   * that carries the rating as its accessible label, and the numeric
   * rating always renders beside it — colour and fill are never the only
   * carrier of the fact.
   */
  function renderStars(rating) {
    var row = el('span', 'wahpi__stars');
    row.setAttribute('role', 'img');
    row.setAttribute('aria-label', 'Rated ' + rating.toFixed(1) + ' out of 5');
    for (var i = 0; i < 5; i += 1) {
      var fill = Math.max(0, Math.min(1, rating - i));
      var cell = el('span', 'wahpi__star');
      cell.setAttribute('aria-hidden', 'true');
      cell.appendChild(el('span', 'wahpi__star-bg', '★'));
      var overlay = el('span', 'wahpi__star-fill');
      overlay.style.width = fill * 100 + '%';
      overlay.appendChild(el('span', null, '★'));
      cell.appendChild(overlay);
      row.appendChild(cell);
    }
    return row;
  }

  /**
   * The guest rating, when we hold a verified one.
   *
   * Compact and deliberately secondary: fine text and small stars that do
   * not compete with the WhataRate score above. Shown with its review count
   * attached — a rating without one invites a reader to weigh 32 reviews
   * the same as 4,500 — and labelled as not affecting the score, because it
   * does not. An unmatched hotel renders nothing at all rather than an
   * empty star row.
   */
  function renderLiveReputation(data) {
    var rep = data.reputation;
    if (!rep || rep.rating === null || rep.rating === undefined) return null;

    var wrap = section(null);
    var row = el('div', 'wahpi__reputation');
    row.appendChild(el('span', 'wahpi__reputation-label', 'Google rating'));
    row.appendChild(el('span', 'wahpi__reputation-sep', '·'));
    row.appendChild(renderStars(rep.rating));
    row.appendChild(el('span', 'wahpi__reputation-rating', rep.rating.toFixed(1)));
    if (rep.review_count !== null && rep.review_count !== undefined) {
      row.appendChild(el('span', 'wahpi__reputation-sep', '·'));
      row.appendChild(
        el(
          'span',
          'wahpi__reputation-count',
          rep.review_count.toLocaleString() + (rep.review_count === 1 ? ' review' : ' reviews'),
        ),
      );
    }
    row.appendChild(el('span', 'wahpi__reputation-note', 'Context only — not part of the score.'));
    wrap.appendChild(row);
    return wrap;
  }

  /** The measured facts, verbatim from the API. The widget does not compute. */
  function renderLiveReasons(data) {
    var reasons = data.verdict.reasons || [];
    if (reasons.length === 0) return null;
    var wrap = section(null);
    var list = el('ul', 'wahpi__reasons');
    reasons.forEach(function (text) {
      var item = el('li', 'wahpi__reason');
      item.appendChild(el('span', 'wahpi__reason-mark wahpi--neutral', '·'));
      item.appendChild(el('span', 'wahpi__reason-text', text));
      list.appendChild(item);
    });
    wrap.appendChild(list);
    return wrap;
  }

  function liveSignalRow(title, signal, evidence) {
    var row = el('div', 'wahpi__signal');

    var head = el('div', 'wahpi__signal-head');
    head.appendChild(el('span', 'wahpi__signal-name', title));
    head.appendChild(
      el(
        'span',
        'wahpi__signal-weight',
        signal.available ? Math.round(signal.weight_applied * 100) + '% of the score' : 'excluded',
      ),
    );
    row.appendChild(head);

    // An unavailable signal says WHY and contributes nothing. It is never shown
    // as a neutral middling value — that would be indistinguishable from a
    // signal genuinely measured at the middle.
    row.appendChild(
      el(
        'div',
        'wahpi__signal-detail',
        signal.available
          ? evidence
          : SIGNAL_UNAVAILABLE[signal.unavailable_reason] || 'Not measurable for this stay.',
      ),
    );
    return row;
  }

  function renderLiveSignals(data) {
    var s = data.signals;
    var wrap = el('div', 'wahpi__signals');

    var comp = s.comp_set;
    wrap.appendChild(
      liveSignalRow(
        'Comparable hotels',
        comp,
        comp.comps_used +
          ' comparable hotels with a live rate for these exact dates. Median ' +
          formatMoney(comp.median_competitor_nightly) +
          ' per night.' +
          (comp.comps_excluded > 0
            ? ' ' + comp.comps_excluded + ' excluded for having no live rate — never estimated.'
            : ''),
      ),
    );

    var cal = s.calendar;
    wrap.appendChild(
      liveSignalRow(
        'Nearby dates',
        cal,
        cal.neighbours_used +
          ' other bookable check-in dates within ' +
          cal.window_days +
          ' days, same room and length of stay. Median ' +
          formatMoney(cal.median_nearby_nightly) +
          ' per night.' +
          (cal.same_weekday_only
            ? ' Same day of the week throughout.'
            : ' Includes other days of the week.'),
      ),
    );

    // "0 of 4 hotels have no availability" is a double negative the reader has
    // to unpick. State the positive when nothing is sold out.
    var avail = s.compression;
    wrap.appendChild(
      liveSignalRow(
        'Market availability',
        avail,
        avail.sold_out === 0
          ? 'All ' +
              avail.checked +
              ' comparable hotels we checked still have availability for these dates.'
          : avail.sold_out +
              ' of ' +
              avail.checked +
              ' comparable hotels we checked are sold out for these dates.',
      ),
    );

    return wrap;
  }

  /**
   * Provenance, mandatory in every state (docs/mvp/08 §H).
   *
   * The last line is the product's central claim and its central limit in one
   * sentence. It is not marketing copy and must not be trimmed for space.
   */
  function renderLiveProvenance(data) {
    var wrap = section(null);
    var provenance = el('div', 'wahpi__provenance');

    // "Last checked 7 hours ago" and a claim of momentary liveness cannot
    // share a sentence honestly. The time is dynamic (relativeTime handles
    // singular/plural), and the second line describes what the system
    // actually did: compared the most recent verified rates it holds.
    var observed = el('div');
    observed.textContent = 'This rate was last checked ' + relativeTime(data.price.observed_at) + '.';
    observed.title = new Date(data.price.observed_at).toISOString();
    provenance.appendChild(observed);

    provenance.appendChild(
      el(
        'div',
        null,
        'Comparisons use the most recent verified rates we hold for comparable hotels. We do not forecast future prices.',
      ),
    );

    wrap.appendChild(provenance);
    return wrap;
  }

  function renderLiveDetails(data, state) {
    var wrap = el('section', 'wahpi__section wahpi__details');

    var panel = el('div', 'wahpi__details-panel');
    panel.id = 'wahpi-live-details-' + state.uid;
    panel.appendChild(renderLiveSignals(data));

    var toggle = el('button', 'wahpi__disclosure');
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', panel.id);

    var label = el('span', 'wahpi__disclosure-label');
    var caret = el('span', 'wahpi__disclosure-caret');
    caret.setAttribute('aria-hidden', 'true');

    function paint() {
      label.textContent = state.expanded
        ? 'Hide the detail'
        : 'How we worked this out — comp set, nearby dates, availability';
      caret.textContent = state.expanded ? '▲' : '▼';
      toggle.setAttribute('aria-expanded', state.expanded ? 'true' : 'false');
      panel.hidden = !state.expanded;
    }

    toggle.appendChild(label);
    toggle.appendChild(caret);
    toggle.addEventListener('click', function () {
      state.expanded = !state.expanded;
      paint();
    });

    paint();
    wrap.appendChild(toggle);
    wrap.appendChild(panel);
    return wrap;
  }

  /**
   * The first paint is the DECISION THIRD: brand, the stay, the price, the
   * score, and why you might choose the hotel — then SEE MORE. Everything
   * analytical (the narrative, premium insight, personalization, the
   * superior alternative, the workings) expands in place and collapses
   * again; the CTAs and the provenance line never hide, because a booking
   * button behind a fold is a conversion killed and a provenance line
   * behind one is honesty deferred.
   */
  function renderLive(root, data, state) {
    root.textContent = '';
    root.className = 'wahpi';
    root.setAttribute('aria-busy', 'false');

    append(root, renderBrand());
    append(root, renderLiveSubject(data));
    append(root, renderRoomPicker(data, state));
    append(root, renderRatePicker(data, state));
    append(root, renderPreferencePicker(data, state));
    append(root, renderLivePrice(data));
    append(root, renderLiveVerdict(data));
    append(root, renderLiveWhyChoose(data));

    var more = el('div', 'wahpi__more');
    more.id = 'wahpi-more-' + state.uid;
    append(more, renderLiveExplanation(data));
    append(more, renderLivePremium(data));
    append(more, renderLiveReputation(data));
    append(more, renderSuperiorAlternative(data, state));
    append(more, renderLivePersonalization(data));
    append(more, renderLiveReasons(data));
    append(more, renderLiveDetails(data, state));

    if (more.childNodes.length > 0) {
      var seeMoreWrap = section(null);
      var toggle = el('button', 'wahpi__see-more');
      toggle.type = 'button';
      toggle.setAttribute('aria-controls', more.id);
      function paintMore() {
        toggle.textContent = state.seeMore ? 'SEE LESS ▲' : 'SEE MORE ▼';
        toggle.setAttribute('aria-expanded', state.seeMore ? 'true' : 'false');
        more.hidden = !state.seeMore;
      }
      toggle.addEventListener('click', function () {
        state.seeMore = !state.seeMore;
        paintMore();
      });
      paintMore();
      seeMoreWrap.appendChild(toggle);
      root.appendChild(seeMoreWrap);
      root.appendChild(more);
    }

    append(root, renderLiveProvenance(data));
    append(root, renderActions(data, state.options));
  }

  // ── states ─────────────────────────────────────────────────────────────

  function renderLoading(root) {
    root.textContent = '';
    root.className = 'wahpi';
    // Never a partial verdict: a score that renders before its confidence would
    // be read and acted on.
    ['32px', '64px', '96px', '48px'].forEach(function (height) {
      var block = el('div', 'wahpi__skeleton');
      block.style.height = height;
      block.style.marginBottom = '14px';
      root.appendChild(block);
    });
    root.appendChild(el('span', 'wahpi__sr', 'Loading price analysis'));
  }

  function renderNotice(root, title, message) {
    root.textContent = '';
    root.className = 'wahpi';
    var wrap = section(null);
    wrap.appendChild(el('h2', null, title));
    wrap.appendChild(el('p', 'wahpi__notice', message));
    root.appendChild(wrap);
  }

  /**
   * The supporting evidence, behind a disclosure.
   *
   * Embedded in a real hotel page the widget ran taller than the room card it
   * describes, pushing the rest of the rooms roughly three screens down on
   * mobile. A price analysis that buries the booking flow works against the
   * thing it exists to support.
   *
   * What collapses is the reasoning, the history chart and the comparison
   * panel — the three tallest blocks, and the ones a customer consults only
   * once the headline has made them curious. The WHY bullets in particular
   * restate the explanation sentence that stays visible above.
   *
   * What does NOT collapse: subject, price, the two scores, the verdict, the
   * explanation, and the whole provenance block including every caveat.
   * docs/mvp/08 §H calls provenance "mandatory in every state" and "what makes
   * the product honest" — hiding a caveat to save space would be trading
   * exactly the wrong thing for room.
   */
  function renderDetails(root, data, state) {
    var wrap = el('section', 'wahpi__section wahpi__details');

    var panel = el('div', 'wahpi__details-panel');
    panel.id = 'wahpi-details-' + state.uid;

    append(panel, renderReasons(data));
    append(
      panel,
      renderHistory(data, state.windowDays, function (days) {
        state.windowDays = days;
        renderAnalysis(root, data, state);
      }),
    );
    append(panel, renderStats(data));

    var toggle = el('button', 'wahpi__disclosure');
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', panel.id);
    toggle.setAttribute('aria-expanded', state.expanded ? 'true' : 'false');

    var label = el('span', 'wahpi__disclosure-label');
    var caret = el('span', 'wahpi__disclosure-caret');
    caret.setAttribute('aria-hidden', 'true');

    function paint() {
      label.textContent = state.expanded
        ? 'Hide the detail'
        : 'How we worked this out — history, comparison and reasoning';
      caret.textContent = state.expanded ? '▲' : '▼';
      toggle.setAttribute('aria-expanded', state.expanded ? 'true' : 'false');
      panel.hidden = !state.expanded;
    }

    toggle.appendChild(label);
    toggle.appendChild(caret);
    toggle.addEventListener('click', function () {
      state.expanded = !state.expanded;
      paint();
    });

    paint();
    wrap.appendChild(toggle);
    wrap.appendChild(panel);
    return wrap;
  }

  function renderAnalysis(root, data, state) {
    root.textContent = '';
    root.className = 'wahpi';
    root.setAttribute('aria-busy', 'false');

    data.gate_hint = data.verdict.recommendation === 'INSUFFICIENT_DATA' ? 'G0' : data.gate_hint;

    append(root, renderBrand());
    append(root, renderSubject(data));
    append(root, renderPrice(data));
    append(root, renderVerdict(data));
    append(root, renderExplanation(data));

    if (data.verdict.recommendation !== 'INSUFFICIENT_DATA') {
      append(root, renderDetails(root, data, state));
    }

    append(root, renderProvenance(data));
    append(root, renderActions(data, state.options));
  }

  function append(parent, child) {
    if (child) parent.appendChild(child);
  }

  // ── mount ──────────────────────────────────────────────────────────────

  function buildUrl(options, live) {
    var base = options.apiBase !== undefined ? options.apiBase : DEFAULT_API_BASE;
    var params = new URLSearchParams({
      hotel_id: options.hotelId,
      check_in: options.checkIn,
      check_out: options.checkOut,
      adults: String(options.adults || 2),
      children: String(options.children || 0),
    });
    if (!live) params.set('include', 'explanation,history,comparables');
    if (options.roomTypeId) params.set('room_type_id', String(options.roomTypeId));
    if (live && options.rateId) params.set('rate_id', String(options.rateId));
    // The source's own booking code, from a per-category button on the host
    // page. The server resolves it to the exact room and rate.
    if (live && options.roomCode) params.set('room_code', String(options.roomCode));
    if (options.currency) params.set('currency', options.currency);
    // GENERAL_VALUE is the server default; sending nothing keeps the URL —
    // and any CDN cache entry — identical to the pre-Phase-6 one.
    if (live && options.preference && options.preference !== 'GENERAL_VALUE') {
      params.set('preference', options.preference);
    }
    return (
      base +
      (live ? '/api/v1/live-intelligence?' : '/api/v1/price-intelligence?') +
      params.toString()
    );
  }

  /**
   * Why a panel hid. Declared before mount() so both it and the auto-init
   * below can report; see the fuller note at the auto-init block.
   */
  function explain(level, message) {
    try {
      if (typeof console === 'undefined') return;
      var fn = console[level] || console.log;
      if (fn) fn.call(console, '[wah-pi] ' + message);
    } catch (e) {
      /* a logging failure must never break the host page */
    }
  }

  function hideRoot(root) {
    root.textContent = '';
    root.className = 'wahpi';
    root.style.display = 'none';
    root.setAttribute('aria-busy', 'false');
  }

  /**
   * How long a request may run. Longer than a normal API budget on purpose:
   * a stay nothing has collected triggers on-demand collection server-side
   * (fetch live, validate, score), which takes seconds rather than
   * milliseconds. The staged messages below are what keep that wait from
   * reading as a broken page.
   */
  // Just OVER the server's 60s function cap (vercel.json maxDuration), so on
  // a cold stay — where the API fetches the subject and its comparables from
  // the source before it can score — the widget outlives the server instead
  // of aborting first. A guest a second from an answer was being shown the
  // unavailable state by our own timer.
  var REQUEST_TIMEOUT_MS = 65000;

  /**
   * The stay a room-category choice belongs to.
   *
   * A room_type_id is only meaningful for the dates and occupancy it was
   * priced for, so a pinned choice must survive an incidental remount and be
   * dropped when the guest actually changes the stay.
   */
  function staySignature(config) {
    return [
      config.hotelId || '',
      config.checkIn || '',
      config.checkOut || '',
      config.adults || '',
      config.children || '',
    ].join('|');
  }

  function mount(root, options) {
    if (!root) throw new Error('WahPriceIntelligence.mount: no element supplied');
    options = options || {};
    root.style.display = '';

    // Live is the default: it needs no accrued history, so it answers on a
    // hotel we started collecting last week instead of showing INSUFFICIENT_DATA
    // for a fortnight.
    var live = options.model !== 'history';
    var state = {
      windowDays: 90,
      seeMore: options.seeMore === true,
      options: options,
      // Collapsed by default. A host page that has room — a dedicated rate
      // page rather than a room row — can pass expanded: true.
      expanded: options.expanded === true,
      // Distinguishes aria-controls ids when several widgets share a page.
      uid: (mount.seq = (mount.seq || 0) + 1),
    };

    // Picking a room category re-mounts this element with that room pinned.
    // It goes through mount() rather than patching the panel in place because
    // EVERYTHING changes — price, score, confidence, comp set, reasons — and a
    // partial repaint is how a new score ends up beside an old explanation.
    //
    // `expanded` rides along so a guest who opened the workings keeps them
    // open, and mount()'s own generation counter invalidates the in-flight
    // request, so a slow answer for the previous room cannot land on this one.
    state.onRoomChange = function (roomTypeId) {
      var next = {};
      for (var key in options) {
        if (Object.prototype.hasOwnProperty.call(options, key)) next[key] = options[key];
      }
      next.roomTypeId = roomTypeId;
      next.expanded = state.expanded;
      next.seeMore = state.seeMore;
      // A rate id belongs to the room it priced: a different room has
      // different offers, so the rate pin is dropped with the room change.
      delete next.rateId;
      root.__wahpiRate = null;
      // Remember the choice against the stay it was made for, so an unrelated
      // remount (the host page firing an input event) does not silently throw
      // it away — and a REAL stay change does, because a room id belongs to
      // the dates it was priced for. See autoConfig.
      root.__wahpiRoom = { stay: staySignature(next), roomTypeId: roomTypeId };
      mount(root, next);
    };

    // Picking a rate re-mounts with that plan pinned, keyed to the stay AND
    // the room it was chosen for — a plan for one room says nothing about
    // another room's offers.
    state.onRateChange = function (rateId) {
      var next = {};
      for (var key in options) {
        if (Object.prototype.hasOwnProperty.call(options, key)) next[key] = options[key];
      }
      next.rateId = rateId;
      next.expanded = state.expanded;
      next.seeMore = state.seeMore;
      root.__wahpiRate = {
        stay: staySignature(next) + '|' + (next.roomTypeId || ''),
        rateId: rateId,
      };
      mount(root, next);
    };

    // Picking a preference re-mounts with it, same shape as the room picker.
    // Unlike a room id, a preference is the GUEST's property, not the stay's:
    // it survives room changes and date changes alike, so it is remembered
    // unconditionally (see autoConfig) until the guest picks another.
    state.onPreferenceChange = function (preference) {
      var next = {};
      for (var key in options) {
        if (Object.prototype.hasOwnProperty.call(options, key)) next[key] = options[key];
      }
      next.preference = preference;
      next.expanded = state.expanded;
      next.seeMore = state.seeMore;
      root.__wahpiPref = preference;
      mount(root, next);
    };

    // A remount (the host page changed dates or hotel) invalidates any fetch
    // still in flight for this element: the older answer must never paint
    // over the newer question.
    var gen = (root.__wahpiGen = (root.__wahpiGen || 0) + 1);
    function fresh() {
      return root.__wahpiGen === gen;
    }

    renderLoading(root);
    root.setAttribute('aria-busy', 'true');
    var status = el('p', 'wahpi__loading-status', 'Checking this stay…');
    root.appendChild(status);
    var stage2 = setTimeout(function () {
      if (fresh()) status.textContent = 'Comparing live rates at similar hotels…';
    }, 2500);
    var stage3 = setTimeout(function () {
      if (fresh()) status.textContent = 'Analyzing price intelligence…';
    }, 7000);
    var stage4 = setTimeout(function () {
      if (fresh()) status.textContent = 'Preparing your recommendation…';
    }, 14000);
    // A cold stay makes the API fetch live rates for these exact dates before
    // it can score, which can take tens of seconds. Say so, or a long wait
    // reads as a hang and the guest closes what was about to answer.
    var stage5 = setTimeout(function () {
      if (fresh())
        status.textContent = 'Fetching live rates for these exact dates — almost there…';
    }, 22000);

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var deadline = setTimeout(function () {
      if (controller) controller.abort();
    }, REQUEST_TIMEOUT_MS);

    function settle() {
      clearTimeout(stage2);
      clearTimeout(stage3);
      clearTimeout(stage4);
      clearTimeout(stage5);
      clearTimeout(deadline);
    }

    // "hide" is for placements that would rather show nothing than a notice —
    // the auto-init default, so an uncatalogued hotel's page looks exactly as
    // it did before the widget existed. The honest no-score notice for a
    // catalogued hotel is kept visible in either mode: that message is the
    // product being truthful, not the product failing.
    function failQuietly(title, message) {
      if (options.unavailable === 'hide') hideRoot(root);
      else renderNotice(root, title, message);
    }

    return fetch(buildUrl(options, live), {
      headers: { accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { status: response.status, body: body };
        });
      })
      .then(function (result) {
        settle();
        if (!fresh()) return null;
        if (result.status === 200) {
          if (live) renderLive(root, result.body, state);
          else renderAnalysis(root, result.body, state);
          return result.body;
        }

        var code = result.body && result.body.error ? result.body.error.code : 'INTERNAL_ERROR';
        if (code === 'NO_CURRENT_RATE') {
          // Honest, and deliberately never hidden behind unavailable:'hide':
          // "we could not verify this" is information a customer can use.
          renderNotice(
            root,
            'Not available for these dates',
            'We could not verify enough live data to score this stay. Try nearby dates, or ask an advisor.',
          );
        } else if (code === 'RATE_NOT_FOUND' && options.rateId) {
          // The pinned offer went away — sold out, withdrawn, or the guest
          // moved the dates. Fall back to the room's current cheapest plan
          // rather than reporting failure for a room that plainly has rates.
          explain(
            'info',
            'rate ' + options.rateId + ' is no longer bookable for this stay — ' +
              'falling back to the lowest available rate for the room.',
          );
          root.__wahpiRate = null;
          var withoutRate = {};
          for (var rk in options) {
            if (Object.prototype.hasOwnProperty.call(options, rk)) withoutRate[rk] = options[rk];
          }
          delete withoutRate.rateId;
          mount(root, withoutRate);
        } else if (code === 'ROOM_TYPE_NOT_FOUND' && options.roomTypeId) {
          // A pinned room category is not bookable for this stay any more —
          // sold out, or the guest moved the dates. Fall back to the engine's
          // pick rather than reporting "not found" for a hotel that plainly
          // has rates: the room went away, the hotel did not.
          explain(
            'info',
            'room category ' +
              options.roomTypeId +
              ' is no longer available for this stay — ' +
              'falling back to the lowest available rate.',
          );
          root.__wahpiRoom = null;
          var withoutRoom = {};
          for (var key in options) {
            if (Object.prototype.hasOwnProperty.call(options, key)) withoutRoom[key] = options[key];
          }
          delete withoutRoom.roomTypeId;
          mount(root, withoutRoom);
        } else if (code === 'HOTEL_NOT_FOUND' || code === 'ROOM_TYPE_NOT_FOUND') {
          // The commonest "it does nothing" report during integration, and the
          // one case where hiding is CORRECT: the embed is fine, the hotel is
          // simply not collected yet. Say so, or a working integration and a
          // broken one look identical.
          explain(
            'info',
            'hotel "' +
              options.hotelId +
              '" is not in the price-intelligence catalogue yet — panel hidden. ' +
              'The embed is working; coverage is added city by city.',
          );
          failQuietly('Not found', 'We could not find that hotel or room type.');
        } else {
          // Rule: never a fabricated or last-known score presented as current.
          failQuietly(
            'Price analysis unavailable',
            'We could not load the price analysis just now. Please try again shortly.',
          );
        }
        return null;
      })
      .catch(function () {
        settle();
        if (!fresh()) return null;
        failQuietly(
          'Price analysis unavailable',
          'We could not reach the price intelligence service. Please try again shortly.',
        );
        return null;
      });
  }

  // ── auto-init ────────────────────────────────────────────────────────────
  //
  // The zero-JavaScript embed. A host template renders
  //
  //   <div data-wah-pi data-hotel-id="1198" data-check-in="2026-10-30"
  //        data-check-out="2026-11-02" data-adults="2"></div>
  //
  // and this script does the rest. `data-wah-pi` is a MARKER attribute: the
  // element is found by the attribute selector `[data-wah-pi]`, so the host
  // needs no id and no class. Its value is ignored, except as a convenience
  // shorthand for the hotel id (`data-wah-pi="1198"`).
  //
  // The stay can come from three places, in order of precedence:
  //   1. data-attributes on the element,
  //   2. the page URL's query string (hotelID / checkIn / checkOut / guests —
  //      the names a booking page already carries), so a template that links
  //      to /showRates.cfm?hotelID=…&checkIn=… needs only the marker div,
  //   3. nothing, in which case the panel hides and says why in the console.
  //
  // Invalid or missing inputs mean NO request rather than a broken panel, and
  // changing the data-attributes (a calendar page that swaps dates without a
  // reload) remounts automatically.

  var ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  // `explain` (declared above mount) reports why a panel hid. A silent hide is
  // right for a guest — an uncovered hotel must not clutter the page — but it
  // is indistinguishable from a broken embed for whoever is integrating it.
  // One console line costs the guest nothing and saves the integrator an
  // afternoon.

  /** Query-string value by any of several parameter spellings. */
  function urlParam(names) {
    try {
      if (typeof window === 'undefined' || !window.location) return null;
      var params = new URLSearchParams(window.location.search);
      for (var i = 0; i < names.length; i++) {
        var v = params.get(names[i]);
        if (v !== null && v !== '') return v;
      }
    } catch (e) {
      /* malformed URL: fall through to null */
    }
    return null;
  }

  /**
   * The hotel id from the page's own path.
   *
   * whatahotel.com hotel pages are /hotels/<id>/<Slug>.html — the rates page
   * carries hotelID in the query string, but the detail page carries it only
   * here. Reading it means the marker div works on both without the template
   * having to interpolate anything.
   */
  function urlPathHotelId() {
    try {
      if (typeof window === 'undefined' || !window.location) return null;
      var m = window.location.pathname.match(/\/hotels?\/(\d{2,10})(?:[/.]|$)/i);
      return m ? m[1] : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * A value from the page's own booking form.
   *
   * The hotel pages drive their date fields through a jQuery `pickadate`
   * picker on inputs named/id'd checkIn and checkOut, and the guest selects
   * dates there BEFORE any navigation happens. Reading the live field means
   * the widget answers for what the guest has actually chosen rather than for
   * whatever the URL last said.
   */
  function formValue(selectors) {
    try {
      if (typeof document === 'undefined') return null;
      for (var i = 0; i < selectors.length; i++) {
        var node = document.querySelector(selectors[i]);
        if (node && typeof node.value === 'string' && node.value.trim() !== '') {
          return node.value.trim();
        }
      }
    } catch (e) {
      /* an exotic selector must not break the host page */
    }
    return null;
  }

  /**
   * Every way a host page can mark the element we mount into.
   *
   * `[data-wah-pi]` is the documented marker. The class and id forms exist
   * because the documentation actively led an integrator away from it: the
   * runbook said the host template "needs no id and no class", meaning we do
   * not REQUIRE one — and it was reasonably read as "identify it however you
   * like". The staging embed came back as
   *
   *   <div id="widget" class="wahpi-wrapper wahpi" data-hotel-id="2008" ...>
   *
   * with every stay attribute correct and the one attribute we actually select
   * on missing, so the widget mounted nothing and looked dead.
   *
   * These are all deliberate opt-in markers carrying our own name — NOT
   * `[data-hotel-id]`, which a search-results page could carry on every card
   * and which would mount a panel per row.
   */
  var MOUNT_SELECTOR = '[data-wah-pi],.wahpi,#wahpi,#wah-pi';

  var CHECK_IN_SELECTORS = [
    '#checkIn',
    '#checkin',
    '[name="checkIn"]',
    '[name="checkin"]',
    '[name="check_in"]',
    '[data-wah-check-in]',
  ];
  var CHECK_OUT_SELECTORS = [
    '#checkOut',
    '#checkout',
    '[name="checkOut"]',
    '[name="checkout"]',
    '[name="check_out"]',
    '[data-wah-check-out]',
  ];
  var GUEST_SELECTORS = ['#guests', '[name="guests"]', '[name="adults"]', '#adults'];
  // Rooms count. Not sent to the API — the rate is per room, so two rooms of
  // the same category is the same rate twice — but a change to it is a change
  // to the booking, and the panel should not sit there describing the search
  // the guest just left behind.
  var ROOM_COUNT_SELECTORS = ['#rooms', '[name="rooms"]', '#numRooms', '[name="numRooms"]'];

  /**
   * Normalise a host page's date to YYYY-MM-DD.
   *
   * ISO passes through. MM/DD/YYYY and YYYY/MM/DD are accepted because a
   * ColdFusion template commonly renders one of them, and rejecting a date the
   * page clearly states would strand a correct integration.
   */
  function normalizeDate(value) {
    if (!value) return '';
    var v = String(value).trim();
    if (ISO_DATE.test(v)) return v;
    var pad = function (n) {
      return (n.length === 1 ? '0' : '') + n;
    };
    var us = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (us) return us[3] + '-' + pad(us[1]) + '-' + pad(us[2]);
    var ymd = v.match(/^(\d{4})[/](\d{1,2})[/](\d{1,2})$/);
    if (ymd) return ymd[1] + '-' + pad(ymd[2]) + '-' + pad(ymd[3]);
    return v;
  }

  function autoConfig(node) {
    var ds = node.dataset || {};
    // Data attributes win; the URL is the fallback so a booking page that
    // already carries the stay in its query string needs only the marker div.
    // Precedence: explicit attributes, then the page's live booking form
    // (what the guest has actually picked), then the URL, then the path.
    var hotelId =
      ds.hotelId ||
      (ds.wahPi && ds.wahPi !== '' ? ds.wahPi : null) ||
      urlParam(['hotelID', 'hotelId', 'hotel_id', 'hotel']) ||
      urlPathHotelId();
    var checkIn =
      ds.checkIn ||
      formValue(CHECK_IN_SELECTORS) ||
      urlParam(['checkIn', 'checkin', 'check_in', 'arrive']);
    var checkOut =
      ds.checkOut ||
      formValue(CHECK_OUT_SELECTORS) ||
      urlParam(['checkOut', 'checkout', 'check_out', 'depart']);
    var adults =
      ds.adults || formValue(GUEST_SELECTORS) || urlParam(['adults', 'guests', 'numAdults']);
    var children = ds.children || urlParam(['children', 'numChildren', 'kids']);

    var config = {
      hotelId: hotelId ? String(hotelId).trim() : '',
      checkIn: normalizeDate(checkIn),
      checkOut: normalizeDate(checkOut),
      adults: parseInt(adults || '2', 10) || 2,
      children: parseInt(children || '0', 10) || 0,
      unavailable: ds.unavailable || 'hide',
    };
    if (ds.apiBase) config.apiBase = ds.apiBase;
    if (ds.model) config.model = ds.model;
    if (ds.currency) config.currency = ds.currency;
    if (ds.roomTypeId) config.roomTypeId = ds.roomTypeId;
    if (ds.rateId) config.rateId = ds.rateId;
    if (ds.roomCode) config.roomCode = ds.roomCode;
    // A category the guest picked outranks nothing in the template, but it
    // must not be lost to an unrelated remount — the host page firing an input
    // event should not silently reset the panel to the cheapest room. It is
    // kept only while the STAY is unchanged: a room id priced for one set of
    // dates says nothing about another.
    var pinned = node.__wahpiRoom;
    if (pinned && pinned.stay === staySignature(config)) config.roomTypeId = pinned.roomTypeId;
    // A pinned rate survives only for the exact stay AND room it was chosen
    // for; anything else falls back to the room's cheapest plan.
    var pinnedRate = node.__wahpiRate;
    if (pinnedRate && pinnedRate.stay === staySignature(config) + '|' + (config.roomTypeId || '')) {
      config.rateId = pinnedRate.rateId;
    }
    if (ds.helpChatId) config.helpChatId = ds.helpChatId;
    // The preference the guest picked in the panel, or the host template's
    // default. Guest choice wins, and unlike the room it is NOT keyed to the
    // stay — what matters to a guest does not change with their dates.
    if (ds.preference) config.preference = ds.preference;
    if (node.__wahpiPref) config.preference = node.__wahpiPref;
    if (ds.expanded === 'true') config.expanded = true;
    return config;
  }

  /** The reason this config cannot be used, or null when it can. */
  function configProblem(config) {
    if (!config.hotelId) {
      return 'no hotel id — add data-hotel-id to the element, or a hotelID parameter to the page URL';
    }
    if (!ISO_DATE.test(config.checkIn) || !ISO_DATE.test(config.checkOut)) {
      return (
        'check-in/check-out missing or unrecognised (got "' +
        config.checkIn +
        '" and "' +
        config.checkOut +
        '") — expected YYYY-MM-DD or MM/DD/YYYY'
      );
    }
    if (config.checkOut <= config.checkIn) return 'check-out is not after check-in';
    // A stay already begun cannot be scored honestly. ISO strings compare
    // lexicographically, so no Date parsing (and no timezone bugs) needed.
    if (config.checkIn < new Date().toISOString().slice(0, 10)) return 'check-in is in the past';
    return null;
  }

  function autoMount(node) {
    try {
      var config = autoConfig(node);
      var problem = configProblem(config);
      if (problem) {
        explain('warn', 'panel hidden: ' + problem);
        hideRoot(node);
        return;
      }
      mount(node, config);
    } catch (e) {
      // The host page must never break because the widget did.
      explain('warn', 'panel hidden after an unexpected error: ' + (e && e.message));
      try {
        hideRoot(node);
      } catch (e2) {
        /* nothing left to do safely */
      }
    }
  }

  /**
   * Remount every panel when the stay could have changed underneath it.
   *
   * The guest picks dates in the host page's own form, or the page swaps the
   * URL without a reload. Neither touches our data-attributes, so without this
   * the panel would keep showing the score for the stay the page opened with —
   * a stale score presented as current, which is the one thing this product
   * must never do. Debounced, because a date picker fires per keystroke.
   */
  var remountTimer = null;
  var lastSignature = null;

  function stateSignature() {
    return [
      typeof window !== 'undefined' && window.location ? window.location.href : '',
      formValue(CHECK_IN_SELECTORS) || '',
      formValue(CHECK_OUT_SELECTORS) || '',
      formValue(GUEST_SELECTORS) || '',
      formValue(ROOM_COUNT_SELECTORS) || '',
    ].join('|');
  }

  function remountAll(force) {
    var signature = stateSignature();
    if (!force && signature === lastSignature) return;
    lastSignature = signature;
    var nodes = document.querySelectorAll(MOUNT_SELECTOR);
    for (var i = 0; i < nodes.length; i++) autoMount(nodes[i]);
  }

  function scheduleRemount() {
    clearTimeout(remountTimer);
    remountTimer = setTimeout(function () {
      try {
        remountAll(false);
      } catch (e) {
        /* never break the host page */
      }
    }, 400);
  }

  function watchPageState() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    // The guest editing the booking form. Capture phase and delegated from the
    // document, so fields the page renders later are covered too.
    ['change', 'input'].forEach(function (evt) {
      document.addEventListener(
        evt,
        function (e) {
          var t = e && e.target;
          if (!t || !t.matches) return;
          var watched = CHECK_IN_SELECTORS.concat(
            CHECK_OUT_SELECTORS,
            GUEST_SELECTORS,
            ROOM_COUNT_SELECTORS,
          ).join(',');
          try {
            if (t.matches(watched)) scheduleRemount();
          } catch (err) {
            /* selector unsupported in this browser: ignore */
          }
        },
        true,
      );
    });

    // The page changing its own URL: back/forward, and pushState/replaceState
    // for a booking flow that swaps dates without a reload.
    window.addEventListener('popstate', scheduleRemount);
    window.addEventListener('hashchange', scheduleRemount);
    ['pushState', 'replaceState'].forEach(function (fn) {
      try {
        var original = window.history && window.history[fn];
        if (typeof original !== 'function' || original.__wahpiWrapped) return;
        var wrapped = function () {
          var out = original.apply(window.history, arguments);
          scheduleRemount();
          return out;
        };
        wrapped.__wahpiWrapped = true;
        window.history[fn] = wrapped;
      } catch (e) {
        /* a locked-down history object is fine; popstate still covers back */
      }
    });
  }

  /**
   * Warm a stay before anyone asks to see it.
   *
   * A cold stay makes the API fetch live rates before it can score — tens of
   * seconds. The guest spends longer than that just LOOKING at the hotel page
   * before pressing Rate Intel, so start the work the moment the page knows
   * the stay: by the time the panel opens, the answer is stored and arrives
   * in under a second.
   *
   * Two forms, both fire the same GET the panel itself would:
   *   - `WahPriceIntelligence.prefetch({hotelId, checkIn, checkOut, …})`
   *   - any element carrying `data-wah-pi-prefetch` plus the usual
   *     data-attributes (it is never mounted — a hidden div works).
   *
   * Fire-and-forget: the response is discarded here (the server now holds the
   * rates), failures are silent, and each distinct stay is warmed once per
   * page view.
   */
  var prefetched = {};
  function prefetch(options) {
    try {
      var config = options || {};
      if (configProblem(config)) return;
      var url = buildUrl(config, config.model !== 'history');
      if (prefetched[url]) return;
      prefetched[url] = true;
      fetch(url).catch(function () {
        /* warming is best-effort; the panel's own request handles errors */
      });
    } catch (e) {
      /* never break the host page */
    }
  }

  function prefetchMarked() {
    var nodes = document.querySelectorAll('[data-wah-pi-prefetch]');
    for (var i = 0; i < nodes.length; i++) prefetch(autoConfig(nodes[i]));
  }

  function initAuto() {
    if (typeof document === 'undefined') return;
    lastSignature = stateSignature();
    watchPageState();
    prefetchMarked();
    var nodes = document.querySelectorAll(MOUNT_SELECTOR);
    for (var i = 0; i < nodes.length; i++) {
      watchNode(nodes[i]);
      autoMount(nodes[i]);
    }
    // Panels inserted after load (client-side rendering) mount as they appear.
    if (typeof MutationObserver !== 'undefined' && document.body) {
      new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          for (var j = 0; j < m.addedNodes.length; j++) {
            var added = m.addedNodes[j];
            if (added.nodeType !== 1) continue;
            var found =
              added.matches && added.matches(MOUNT_SELECTOR)
                ? [added]
                : added.querySelectorAll
                  ? added.querySelectorAll(MOUNT_SELECTOR)
                  : [];
            for (var k = 0; k < found.length; k++) {
              if (!found[k].__wahpiWatched) {
                watchNode(found[k]);
                autoMount(found[k]);
              }
            }
          }
        });
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  /** Remount (debounced) when the host page rewrites the data-attributes. */
  function watchNode(node) {
    if (node.__wahpiWatched || typeof MutationObserver === 'undefined') {
      node.__wahpiWatched = true;
      return;
    }
    node.__wahpiWatched = true;
    var pending = null;
    new MutationObserver(function () {
      clearTimeout(pending);
      pending = setTimeout(function () {
        autoMount(node);
      }, 250);
    }).observe(node, {
      attributes: true,
      attributeFilter: [
        'data-hotel-id',
        'data-check-in',
        'data-check-out',
        'data-adults',
        'data-children',
        'data-room-type-id',
        'data-rate-id',
        'data-room-code',
        'data-model',
        'data-currency',
        'data-preference',
      ],
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initAuto);
    } else {
      initAuto();
    }
  }

  global.WahPriceIntelligence = {
    mount: mount,
    prefetch: prefetch,
    formatOutOfTen: formatOutOfTen,
    // Exposed for the host page and for tests.
    formatMoney: formatMoney,
    formatPct: formatPct,
    relativeTime: relativeTime,
  };
})(typeof window !== 'undefined' ? window : globalThis);
