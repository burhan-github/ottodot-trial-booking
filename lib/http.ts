import { z } from "zod";
import { BookingError } from "@/lib/booking/errors";

export function errorResponse(code: string, message: string, status: number) {
  return Response.json({ error: code, message }, { status });
}

/** Maps expected failures to 4xx; anything else is a 500 and gets logged. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BookingError) return errorResponse(err.code, err.message, err.httpStatus);
    if (err instanceof z.ZodError) {
      return Response.json(
        { error: "INVALID_REQUEST", message: "Invalid request.", details: z.flattenError(err) },
        { status: 400 },
      );
    }
    console.error(err);
    return errorResponse("INTERNAL_ERROR", "Something went wrong.", 500);
  }
}

export const uuid = z.uuid();
