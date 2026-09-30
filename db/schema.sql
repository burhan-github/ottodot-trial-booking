-- Trial booking schema. Safe to re-run: drops and recreates everything.

DROP FUNCTION IF EXISTS settle_payment(UUID, TEXT, payment_status, TEXT);
DROP TABLE IF EXISTS payment_attempts;
DROP TABLE IF EXISTS bookings;
DROP TABLE IF EXISTS trial_classes;
DROP TABLE IF EXISTS students;
DROP TABLE IF EXISTS parents;
DROP TYPE IF EXISTS booking_status;
DROP TYPE IF EXISTS payment_status;

CREATE TYPE booking_status AS ENUM (
    'pending_payment',
    'confirmed',
    'payment_failed',
    'cancelled'
);

CREATE TYPE payment_status AS ENUM ('succeeded', 'failed');

CREATE TABLE parents (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE students (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id  UUID NOT NULL REFERENCES parents(id),
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Target for the composite FK on bookings (ownership invariant).
    UNIQUE (id, parent_id)
);

CREATE TABLE trial_classes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    starts_at  TIMESTAMPTZ NOT NULL,
    capacity   INTEGER NOT NULL DEFAULT 4 CHECK (capacity > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE bookings (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id      UUID NOT NULL,
    student_id     UUID NOT NULL,
    trial_class_id UUID NOT NULL REFERENCES trial_classes(id),
    status         booking_status NOT NULL DEFAULT 'pending_payment',
    -- Set when status = 'cancelled', e.g. 'class_full'.
    cancel_reason  TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- A parent can only book for their own child, enforced by the database.
    FOREIGN KEY (student_id, parent_id) REFERENCES students(id, parent_id)
);

-- At most one *active* booking per child per class. payment_failed and
-- cancelled bookings do not block a fresh attempt.
CREATE UNIQUE INDEX uq_active_booking_per_student_class
    ON bookings (student_id, trial_class_id)
    WHERE status IN ('pending_payment', 'confirmed');

CREATE INDEX idx_bookings_class_status ON bookings (trial_class_id, status);

CREATE TABLE payment_attempts (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id         UUID NOT NULL REFERENCES bookings(id),
    -- Client-supplied key; a retried request with the same key is a replay.
    idempotency_key    TEXT NOT NULL UNIQUE,
    status             payment_status NOT NULL,
    provider_reference TEXT,
    -- Money was captured but the seat could not be confirmed (lost the race).
    refund_required    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Records a payment result and settles the booking in ONE transaction.
--
-- Lock order is always booking row -> trial class row, so concurrent calls
-- cannot deadlock. Locking the class row serializes every confirmation for
-- that class; the confirmed count is then re-read under the lock. This relies
-- on READ COMMITTED (the Postgres default): each statement takes a fresh
-- snapshot, so the COUNT sees confirmations committed while we were waiting.
--
-- Returns: { outcome, bookingId, status, replayed }
--   outcome = confirmed | payment_failed | class_full | not_payable
CREATE FUNCTION settle_payment(
    p_booking_id         UUID,
    p_idempotency_key    TEXT,
    p_result             payment_status,
    p_provider_reference TEXT
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_booking   bookings%ROWTYPE;
    v_capacity  INTEGER;
    v_confirmed INTEGER;
    v_prior     payment_attempts%ROWTYPE;
BEGIN
    SELECT * INTO v_booking FROM bookings WHERE id = p_booking_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'BOOKING_NOT_FOUND';
    END IF;

    -- Idempotent replay: checked after the booking lock, so a concurrent
    -- double-submit with the same key waits here and then sees the first result.
    SELECT * INTO v_prior FROM payment_attempts WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF v_prior.booking_id <> p_booking_id THEN
            RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED';
        END IF;
        RETURN jsonb_build_object(
            'outcome', CASE v_booking.status
                WHEN 'confirmed' THEN 'confirmed'
                WHEN 'payment_failed' THEN 'payment_failed'
                WHEN 'cancelled' THEN 'class_full'
                ELSE 'not_payable' END,
            'bookingId', p_booking_id,
            'status', v_booking.status,
            'replayed', TRUE);
    END IF;

    IF v_booking.status <> 'pending_payment' THEN
        RETURN jsonb_build_object('outcome', 'not_payable', 'bookingId', p_booking_id,
                                  'status', v_booking.status, 'replayed', FALSE);
    END IF;

    IF p_result = 'failed' THEN
        UPDATE bookings SET status = 'payment_failed', updated_at = NOW()
            WHERE id = p_booking_id;
        INSERT INTO payment_attempts (booking_id, idempotency_key, status, provider_reference)
            VALUES (p_booking_id, p_idempotency_key, 'failed', p_provider_reference);
        RETURN jsonb_build_object('outcome', 'payment_failed', 'bookingId', p_booking_id,
                                  'status', 'payment_failed', 'replayed', FALSE);
    END IF;

    -- Payment succeeded: take the class lock, then re-check capacity.
    SELECT capacity INTO v_capacity FROM trial_classes
        WHERE id = v_booking.trial_class_id FOR UPDATE;

    SELECT COUNT(*) INTO v_confirmed FROM bookings
        WHERE trial_class_id = v_booking.trial_class_id AND status = 'confirmed';

    IF v_confirmed >= v_capacity THEN
        -- Lost the last-seat race after money was captured. Never confirm;
        -- record the capture and flag it for refund.
        UPDATE bookings SET status = 'cancelled', cancel_reason = 'class_full', updated_at = NOW()
            WHERE id = p_booking_id;
        INSERT INTO payment_attempts
            (booking_id, idempotency_key, status, provider_reference, refund_required)
            VALUES (p_booking_id, p_idempotency_key, 'succeeded', p_provider_reference, TRUE);
        RETURN jsonb_build_object('outcome', 'class_full', 'bookingId', p_booking_id,
                                  'status', 'cancelled', 'replayed', FALSE);
    END IF;

    UPDATE bookings SET status = 'confirmed', updated_at = NOW() WHERE id = p_booking_id;
    INSERT INTO payment_attempts (booking_id, idempotency_key, status, provider_reference)
        VALUES (p_booking_id, p_idempotency_key, 'succeeded', p_provider_reference);
    RETURN jsonb_build_object('outcome', 'confirmed', 'bookingId', p_booking_id,
                              'status', 'confirmed', 'replayed', FALSE);
END;
$$;
