-- Extended statistics for the rate-terms and room-kind column groups.
--
-- The planner multiplies single-column selectivities as if the columns were
-- independent, and on these tables they are anything but: meal plan,
-- refundability and audience travel together per source plan, and room class
-- correlates with view type. After the cancelDate mapping (2026-09-11) grew
-- REFUNDABLE from a handful of rate plans to ~1,000 in a day, the
-- independence assumption under-estimated the terms filter by ~600x, the
-- comp-set query kept a nested-loop plan whose inner side suddenly executed
-- ~430,000 times, and every on-demand live-intelligence request died at the
-- platform's 60-second kill (2026-09-12).
--
-- The query itself was restructured to be planner-proof (materialized id-set
-- CTEs in findCompetitorRates) — these statistics are the belt to that
-- suspender: they give the planner the true joint distribution so ANY query
-- over these column groups estimates sanely, including ones not yet written.
--
-- Applied to production live during the incident; this migration makes every
-- database match. CREATE STATISTICS is instant (metadata only); the ANALYZE
-- that populates them runs in the collect workflow and autovacuum besides —
-- cheap on tables this size (thousands of rows).

CREATE STATISTICS IF NOT EXISTS rate_plan_terms_stx (ndistinct, dependencies, mcv)
  ON meal_plan, refund_policy, audience FROM rate_plan;

CREATE STATISTICS IF NOT EXISTS room_type_kind_stx (ndistinct, dependencies, mcv)
  ON room_class, view_type FROM room_type;

ANALYZE rate_plan;
ANALYZE room_type;
