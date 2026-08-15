-- Benefit catalog with realization factors.
-- Rationale for the discounts: docs/mvp/02-deal-score.md, factor F6.
-- A benefit that *might* materialize is not worth its face value.

INSERT INTO benefit (code, display_name, basis, default_value_minor, currency, realization_factor)
VALUES
    ('BREAKFAST_2',    'Breakfast for two',        'PER_NIGHT', 7000,  'USD', 0.70),
    ('HOTEL_CREDIT',   'Hotel credit',             'PER_STAY',  10000, 'USD', 0.80),
    ('RESORT_CREDIT',  'Resort credit',            'PER_STAY',  10000, 'USD', 0.80),
    ('UPGRADE',        'Room upgrade (on avail.)', 'PER_STAY',  NULL,  'USD', 0.35),
    ('LATE_CHECKOUT',  'Late checkout',            'PER_STAY',  5000,  'USD', 0.60),
    ('EARLY_CHECKIN',  'Early check-in',           'PER_STAY',  3000,  'USD', 0.50),
    ('WELCOME_AMENITY','Welcome amenity',          'PER_STAY',  2500,  'USD', 0.90),
    ('WIFI',           'Complimentary Wi-Fi',      'PER_NIGHT', 1500,  'USD', 1.00)
ON CONFLICT (code) DO NOTHING;
