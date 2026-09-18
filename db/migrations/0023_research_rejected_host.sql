-- 0023 — hosts a human has judged NOT to be the property's own site.
--
-- The operator's half of the research loop. Measured over two runs of 25
-- hotels, automated checks catch the cases that generalise — a domain claimed
-- by more than one hotel is a brand domain, a press. subdomain is a newsroom —
-- and miss the ones that do not. `coconutgrove.com` resolved for "Mr. C Miami
-- - Coconut Grove" because the hotel's name contains its neighbourhood, one
-- hotel, one domain, nothing to collide with and nothing to pattern-match.
--
-- Rather than grow a blocklist by guesswork, the sweep RANKS its resolutions
-- by how weakly the name explains the host, a person looks, and what they
-- reject lands here. The list is then evidence of a decision somebody made
-- rather than a rule somebody assumed.
--
-- `reason` is required because a bare host teaches the next reader nothing,
-- and this table will outlive the memory of why any given row is in it.
CREATE TABLE IF NOT EXISTS research_rejected_host (
  host        text        PRIMARY KEY CHECK (host = lower(btrim(host)) AND host <> ''),
  reason      text        NOT NULL CHECK (length(btrim(reason)) > 0),
  rejected_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE research_rejected_host IS
  'Hosts a human judged not to be a property''s own site. Consulted by website resolution; never populated automatically.';
