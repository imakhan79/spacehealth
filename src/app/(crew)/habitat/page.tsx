import { getMe } from "@/lib/dashboard/me";
import { HabitatClient } from "./habitat-client";

export const dynamic = "force-dynamic";

export default async function HabitatPage() {
  return <HabitatClient me={await getMe()} />;
}
