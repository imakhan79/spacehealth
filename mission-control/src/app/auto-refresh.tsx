"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the server component periodically so new uplinks appear. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = window.setInterval(() => router.refresh(), seconds * 1000);
    return () => window.clearInterval(timer);
  }, [router, seconds]);
  return null;
}
