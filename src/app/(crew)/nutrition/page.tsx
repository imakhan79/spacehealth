import { getMe } from "@/lib/dashboard/me";
import { NutritionClient } from "./nutrition-client";

export const dynamic = "force-dynamic";

export default async function NutritionPage() {
  return <NutritionClient me={await getMe()} />;
}
