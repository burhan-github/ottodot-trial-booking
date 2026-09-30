export type BookingErrorCode =
  | "STUDENT_NOT_FOUND"
  | "CLASS_NOT_FOUND"
  | "BOOKING_NOT_FOUND"
  | "DUPLICATE_BOOKING"
  | "CLASS_FULL"
  | "BOOKING_NOT_PAYABLE"
  | "IDEMPOTENCY_KEY_REUSED";

const HTTP_STATUS: Record<BookingErrorCode, number> = {
  STUDENT_NOT_FOUND: 404,
  CLASS_NOT_FOUND: 404,
  BOOKING_NOT_FOUND: 404,
  DUPLICATE_BOOKING: 409,
  CLASS_FULL: 409,
  BOOKING_NOT_PAYABLE: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
};

/** An expected business-rule rejection (as opposed to a bug or outage). */
export class BookingError extends Error {
  readonly httpStatus: number;

  constructor(
    readonly code: BookingErrorCode,
    message: string,
  ) {
    super(message);
    this.httpStatus = HTTP_STATUS[code];
  }
}
