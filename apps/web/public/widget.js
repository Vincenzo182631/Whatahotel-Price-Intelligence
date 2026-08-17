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
 * Usage:
 *   WahPriceIntelligence.mount(element, {
 *     apiBase, hotelId, checkIn, checkOut, adults, children, roomTypeId
 *   });
 */
(function (global) {
  'use strict';

  var DEFAULT_API_BASE = '';

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
    WAIT: 'wahpi--warn',
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
    var meta =
      data.subject.room_type.name +
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

    if (data.subject.room_type.selected_by === 'ENGINE') {
      wrap.appendChild(
        el(
          'div',
          'wahpi__auto-room',
          'Showing the lowest available rate: ' + data.subject.room_type.name + '.',
        ),
      );
    }
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

    // Rule: tax basis explicit, never ambiguous.
    var taxText =
      data.price.tax_basis === 'GROSS'
        ? 'Includes taxes and fees'
        : data.price.tax_basis === 'NET'
          ? 'Before taxes and fees'
          : 'Tax treatment unconfirmed';
    wrap.appendChild(el('div', 'wahpi__tax', taxText));

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

  function renderActions(data, options) {
    var wrap = section(null);
    var actions = el('div', 'wahpi__actions');

    var book = el('a', 'wahpi__btn wahpi__btn--primary', 'Book this rate');
    book.href = options.bookingUrl || '#';
    if (!options.bookingUrl) {
      book.className = 'wahpi__btn wahpi__btn--disabled';
      book.setAttribute('aria-disabled', 'true');
      book.title = 'Booking link is supplied by the host page';
    }
    actions.appendChild(book);

    var advisor = el('a', 'wahpi__btn wahpi__btn--secondary', 'Talk to a Lorraine Travel advisor');
    // Carry the analysis context so the advisor opens already knowing the stay.
    advisor.href =
      (options.advisorUrl || '#') +
      (options.advisorUrl ? (options.advisorUrl.indexOf('?') === -1 ? '?' : '&') : '') +
      (options.advisorUrl ? 'analysis_id=' + encodeURIComponent(data.analysis_id) : '');
    if (!options.advisorUrl) {
      advisor.className = 'wahpi__btn wahpi__btn--disabled';
      advisor.setAttribute('aria-disabled', 'true');
    }
    actions.appendChild(advisor);

    wrap.appendChild(actions);
    return wrap;
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

  function buildUrl(options) {
    var base = options.apiBase !== undefined ? options.apiBase : DEFAULT_API_BASE;
    var params = new URLSearchParams({
      hotel_id: options.hotelId,
      check_in: options.checkIn,
      check_out: options.checkOut,
      adults: String(options.adults || 2),
      children: String(options.children || 0),
      include: 'explanation,history,comparables',
    });
    if (options.roomTypeId) params.set('room_type_id', String(options.roomTypeId));
    if (options.currency) params.set('currency', options.currency);
    return base + '/api/v1/price-intelligence?' + params.toString();
  }

  function mount(root, options) {
    if (!root) throw new Error('WahPriceIntelligence.mount: no element supplied');
    var state = {
      windowDays: 90,
      options: options,
      // Collapsed by default. A host page that has room — a dedicated rate
      // page rather than a room row — can pass expanded: true.
      expanded: options.expanded === true,
      // Distinguishes aria-controls ids when several widgets share a page.
      uid: (mount.seq = (mount.seq || 0) + 1),
    };

    renderLoading(root);
    root.setAttribute('aria-busy', 'true');

    return fetch(buildUrl(options), { headers: { accept: 'application/json' } })
      .then(function (response) {
        return response.json().then(function (body) {
          return { status: response.status, body: body };
        });
      })
      .then(function (result) {
        if (result.status === 200) {
          renderAnalysis(root, result.body, state);
          return result.body;
        }

        var code = result.body && result.body.error ? result.body.error.code : 'INTERNAL_ERROR';
        if (code === 'NO_CURRENT_RATE') {
          renderNotice(
            root,
            'Not available for these dates',
            'We do not have a live rate for this room on these dates. Try nearby dates, or ask an advisor.',
          );
        } else if (code === 'HOTEL_NOT_FOUND' || code === 'ROOM_TYPE_NOT_FOUND') {
          renderNotice(root, 'Not found', 'We could not find that hotel or room type.');
        } else {
          // Rule: never a fabricated or last-known score presented as current.
          renderNotice(
            root,
            'Price analysis unavailable',
            'We could not load the price analysis just now. Please try again shortly.',
          );
        }
        return null;
      })
      .catch(function () {
        renderNotice(
          root,
          'Price analysis unavailable',
          'We could not reach the price intelligence service. Please try again shortly.',
        );
        return null;
      });
  }

  global.WahPriceIntelligence = {
    mount: mount,
    // Exposed for the host page and for tests.
    formatMoney: formatMoney,
    formatPct: formatPct,
    relativeTime: relativeTime,
  };
})(typeof window !== 'undefined' ? window : globalThis);
