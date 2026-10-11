import { useConvexConnectionState } from "convex/react";
import { useEffect, useState } from "react";

/** Brief drops are common (sleep, network switch); only show the banner if the drop lasts. */
const SHOW_AFTER_MS = 1500;

function useBrowserOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

export function ConnectionBanner() {
  const state = useConvexConnectionState();
  // The Convex socket can take up to a minute to notice a dead network, so the browser's own
  // offline signal is used as well.
  const online = useBrowserOnline();
  const disconnected = !online || (state.hasEverConnected && !state.isWebSocketConnected);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!disconnected) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [disconnected]);

  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="reconnecting-banner"
      className="sticky top-0 z-[60] w-full border-b border-sky-800 bg-sky-950/95 px-4 py-1.5 text-center text-xs font-medium text-sky-100"
    >
      Reconnecting… You are seeing the last data received. Changes are paused until the connection returns.
    </div>
  );
}
