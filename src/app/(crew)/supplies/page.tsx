import { getMe } from "@/lib/dashboard/me";
import { SuppliesClient } from "./supplies-client";

export const dynamic = "force-dynamic";

export default async function SuppliesPage() {
  return <SuppliesClient me={await getMe()} />;
}
