import { listTrialClasses } from "@/lib/booking/service";
import { handle } from "@/lib/http";

export const dynamic = "force-dynamic";

export function GET() {
  return handle(async () => Response.json(await listTrialClasses()));
}
