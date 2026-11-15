import { getMe } from "@/lib/dashboard/me";
import { SleepClient } from "./sleep-client";

export const dynamic = "force-dynamic";

export default async function SleepPage() {
  return <SleepClient me={await getMe()} />;
}
