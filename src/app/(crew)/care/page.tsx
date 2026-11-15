import { getMe } from "@/lib/dashboard/me";
import { CareClient } from "./care-client";

export const dynamic = "force-dynamic";

export default async function CarePage() {
  return <CareClient me={await getMe()} />;
}
