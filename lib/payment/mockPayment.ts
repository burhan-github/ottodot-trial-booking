import { randomUUID } from "node:crypto";

export type PaymentResult = "succeeded" | "failed";

/**
 * Stand-in for a payment provider. The caller chooses the outcome so the demo
 * can exercise both paths. The small delay mimics a network round trip, which
 * is exactly the window in which a competing parent can take the last seat.
 */
export async function mockPayment(result: PaymentResult) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { status: result, providerReference: `MOCK-${randomUUID()}` };
}
