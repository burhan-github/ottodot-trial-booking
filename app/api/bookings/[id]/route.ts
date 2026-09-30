import { getBooking } from "@/lib/booking/service";
import { errorResponse, handle, uuid } from "@/lib/http";

export const dynamic = "force-dynamic";

export function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const booking = await getBooking(uuid.parse((await params).id));
    if (!booking) return errorResponse("BOOKING_NOT_FOUND", "Booking not found.", 404);
    return Response.json(booking);
  });
}
