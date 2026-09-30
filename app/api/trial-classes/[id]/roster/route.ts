import { getRoster } from "@/lib/booking/service";
import { handle, uuid } from "@/lib/http";

export const dynamic = "force-dynamic";

// Admin/teacher view: confirmed students only.
export function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = uuid.parse((await params).id);
    return Response.json(await getRoster(id));
  });
}
