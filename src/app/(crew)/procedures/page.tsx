import { getMe } from "@/lib/dashboard/me";
import { ProceduresClient } from "./procedures-client";

export const dynamic = "force-dynamic";

export default async function ProceduresPage() {
  return <ProceduresClient me={await getMe()} />;
}
