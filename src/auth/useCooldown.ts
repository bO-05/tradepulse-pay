import { useCallback, useEffect, useState } from "react";
import { RESEND_COOLDOWN_SECONDS } from "../../convex/lib/authErrors";

export const RESEND_COOLDOWN_MS = RESEND_COOLDOWN_SECONDS * 1000;

/** Seconds left until `until` (ms epoch), ticking once a second; 0 when the cooldown is over. */
export function useCooldown(initialUntil: number) {
  const [until, setUntil] = useState(initialUntil);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= now) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [until, now]);
  const restart = useCallback((ms: number = RESEND_COOLDOWN_MS) => {
    const at = Date.now();
    setNow(at);
    setUntil(at + ms);
  }, []);
  return { secondsLeft: Math.max(0, Math.ceil((until - now) / 1000)), restart };
}
