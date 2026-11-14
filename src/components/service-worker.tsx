"use client";

import { useEffect } from "react";

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // Requires HTTPS with a trusted cert (data/tls/ca.crt installed); the
      // app still works without it, just not when the web server is down.
    });
  }, []);
  return null;
}
