-- Synthetic demo data. Each class covers one scenario from the brief.

INSERT INTO parents (id, name, email) VALUES
    ('11111111-1111-4111-8111-111111111111', 'Alice Tan', 'alice@example.com'),
    ('22222222-2222-4222-8222-222222222222', 'Bob Lim',   'bob@example.com'),
    ('33333333-3333-4333-8333-333333333333', 'Chen Wei',  'chen@example.com'),
    ('44444444-4444-4444-8444-444444444444', 'Dewi Sari', 'dewi@example.com');

INSERT INTO students (id, parent_id, name) VALUES
    ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Emma Tan'),
    ('aaaaaaaa-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'Noah Tan'),
    ('aaaaaaaa-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', 'Oliver Lim'),
    ('aaaaaaaa-0000-4000-8000-000000000004', '22222222-2222-4222-8222-222222222222', 'Mia Lim'),
    ('aaaaaaaa-0000-4000-8000-000000000005', '33333333-3333-4333-8333-333333333333', 'Lucas Wei'),
    ('aaaaaaaa-0000-4000-8000-000000000006', '33333333-3333-4333-8333-333333333333', 'Ava Wei'),
    ('aaaaaaaa-0000-4000-8000-000000000007', '44444444-4444-4444-8444-444444444444', 'Zara Sari'),
    ('aaaaaaaa-0000-4000-8000-000000000008', '44444444-4444-4444-8444-444444444444', 'Kai Sari');

INSERT INTO trial_classes (id, name, starts_at, capacity) VALUES
    -- Exactly 3 confirmed: the last-seat race demo.
    ('cccccccc-0000-4000-8000-000000000001', 'Science: Forces & Motion', '2026-10-12 10:00:00+08', 4),
    -- Available seats + an existing payment failure.
    ('cccccccc-0000-4000-8000-000000000002', 'Math: Fractions',          '2026-10-13 10:00:00+08', 4),
    -- Already full.
    ('cccccccc-0000-4000-8000-000000000003', 'Science: Energy',          '2026-10-14 10:00:00+08', 4);

INSERT INTO bookings (id, parent_id, student_id, trial_class_id, status) VALUES
    -- Forces & Motion: 3 / 4. Booking Emma again = duplicate booking case.
    ('bbbbbbbb-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', 'confirmed'),
    ('bbbbbbbb-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'aaaaaaaa-0000-4000-8000-000000000003', 'cccccccc-0000-4000-8000-000000000001', 'confirmed'),
    ('bbbbbbbb-0000-4000-8000-000000000003', '33333333-3333-4333-8333-333333333333', 'aaaaaaaa-0000-4000-8000-000000000005', 'cccccccc-0000-4000-8000-000000000001', 'confirmed'),
    -- Fractions: Mia's payment failed; she is NOT on the roster.
    ('bbbbbbbb-0000-4000-8000-000000000004', '22222222-2222-4222-8222-222222222222', 'aaaaaaaa-0000-4000-8000-000000000004', 'cccccccc-0000-4000-8000-000000000002', 'payment_failed'),
    -- Energy: 4 / 4.
    ('bbbbbbbb-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000003', 'confirmed'),
    ('bbbbbbbb-0000-4000-8000-000000000006', '33333333-3333-4333-8333-333333333333', 'aaaaaaaa-0000-4000-8000-000000000006', 'cccccccc-0000-4000-8000-000000000003', 'confirmed'),
    ('bbbbbbbb-0000-4000-8000-000000000007', '44444444-4444-4444-8444-444444444444', 'aaaaaaaa-0000-4000-8000-000000000007', 'cccccccc-0000-4000-8000-000000000003', 'confirmed'),
    ('bbbbbbbb-0000-4000-8000-000000000008', '44444444-4444-4444-8444-444444444444', 'aaaaaaaa-0000-4000-8000-000000000008', 'cccccccc-0000-4000-8000-000000000003', 'confirmed');

INSERT INTO payment_attempts (booking_id, idempotency_key, status, provider_reference) VALUES
    ('bbbbbbbb-0000-4000-8000-000000000001', 'seed-1', 'succeeded', 'MOCK-seed-1'),
    ('bbbbbbbb-0000-4000-8000-000000000002', 'seed-2', 'succeeded', 'MOCK-seed-2'),
    ('bbbbbbbb-0000-4000-8000-000000000003', 'seed-3', 'succeeded', 'MOCK-seed-3'),
    ('bbbbbbbb-0000-4000-8000-000000000004', 'seed-4', 'failed',    'MOCK-seed-4'),
    ('bbbbbbbb-0000-4000-8000-000000000005', 'seed-5', 'succeeded', 'MOCK-seed-5'),
    ('bbbbbbbb-0000-4000-8000-000000000006', 'seed-6', 'succeeded', 'MOCK-seed-6'),
    ('bbbbbbbb-0000-4000-8000-000000000007', 'seed-7', 'succeeded', 'MOCK-seed-7'),
    ('bbbbbbbb-0000-4000-8000-000000000008', 'seed-8', 'succeeded', 'MOCK-seed-8');
