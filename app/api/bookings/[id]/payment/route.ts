import { z } from "zod";
import { payForBooking } from "@/lib/booking/service";
import { errorResponse, handle, uuid } from "@/lib/http";

const paymentSchema = z.object({ result: z.enum(["succeeded", "failed"]) });

const OUTCOME_ERRORS = {
  class_full: ["CLASS_FULL", "This class is already full."],
  not_payable: ["BOOKING_NOT_PAYABLE", "This booking can no longer be paid."],
} as const;

/**
 * Requires an Idempotency-Key header. Retrying with the same key returns the
 * original result instead of charging again.
 * A failed payment is a successful request with a business outcome (200).
 */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const bookingId = uuid.parse((await params).id);
    const idempotencyKey = req.headers.get("Idempotency-Key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
      return errorResponse("INVALID_REQUEST", "An Idempotency-Key header is required.", 400);
    }
    const { result } = paymentSchema.parse(await req.json());

    const outcome = await payForBooking({ bookingId, idempotencyKey, result });
    if (outcome.outcome === "class_full" || outcome.outcome === "not_payable") {
      const [error, message] = OUTCOME_ERRORS[outcome.outcome];
      return Response.json({ error, message, ...outcome }, { status: 409 });
    }
    return Response.json(outcome);
  });
}
