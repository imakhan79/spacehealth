import { getMe } from "@/lib/dashboard/me";
import { EvaClient } from "./eva-client";

export const dynamic = "force-dynamic";

export default async function EvaPage() {
  return <EvaClient me={await getMe()} />;
}
