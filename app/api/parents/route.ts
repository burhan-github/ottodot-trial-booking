import { listParentsWithStudents } from "@/lib/booking/service";
import { handle } from "@/lib/http";

export const dynamic = "force-dynamic";

// Stand-in for "the logged-in parent": there is no auth in this slice.
export function GET() {
  return handle(async () => Response.json(await listParentsWithStudents()));
}
