import { z } from "zod";
import { createBooking } from "@/lib/booking/service";
import { handle, uuid } from "@/lib/http";

const createBookingSchema = z.object({
  parentId: uuid,
  studentId: uuid,
  trialClassId: uuid,
});

export function POST(req: Request) {
  return handle(async () => {
    const input = createBookingSchema.parse(await req.json());
    return Response.json(await createBooking(input), { status: 201 });
  });
}
