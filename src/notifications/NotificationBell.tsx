import { useMutation, useQuery } from "convex/react";
import { Bell } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import { NOTIFICATIONS_HASH } from "../auth/navigation";
import { cx, focusRing } from "../ui";
import { NotificationItem } from "./NotificationItem";

/** Shell bell: unread badge, popover with the newest notifications, mark read and "See all". */
export function NotificationBell() {
  const summary = useQuery(api.notifications.summary, {});
  const markAllRead = useMutation(api.notifications.markAllRead);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unread = summary?.unreadCount ?? 0;
  const countText = summary?.unreadCapped ? "99+" : String(unread);
  const label = unread > 0 ? `Notifications, ${countText} unread` : "Notifications";

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="notification-bell"
        onClick={() => setOpen((o) => !o)}
        className={cx("relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 text-slate-200 hover:bg-slate-800", focusRing)}
      >
        <Bell aria-hidden="true" className="h-[18px] w-[18px]" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            data-testid="notification-badge"
            className="absolute -right-1.5 -top-1.5 min-w-[18px] rounded-full bg-rose-600 px-1 text-center text-[10px] font-bold leading-[18px] text-white"
          >
            {countText}
          </span>
        )}
      </button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Notifications"
          className="fixed inset-x-3 top-16 z-dialog overflow-hidden sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-[22rem] rounded-xl border border-slate-700 bg-slate-900 shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
            <h2 className="text-sm font-semibold text-slate-100">Notifications</h2>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void markAllRead({})}
                className={cx("rounded px-1.5 py-1 text-xs text-emerald-300 hover:bg-slate-800", focusRing)}
              >
                Mark all as read
              </button>
            )}
          </div>
          {summary === undefined ? (
            <p className="px-3 py-4 text-sm text-slate-400">Loading…</p>
          ) : summary.latest.length === 0 ? (
            <div className="px-3 py-6 text-center">
              <p className="text-sm font-semibold text-slate-100">You're all caught up</p>
              <p className="mt-1 text-xs text-slate-400">New activity for your company shows up here.</p>
            </div>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {summary.latest.map((n) => (
                <NotificationItem key={n._id} n={n} onOpen={() => setOpen(false)} />
              ))}
            </ul>
          )}
          <div className="border-t border-slate-800 px-3 py-2 text-right">
            <a href={NOTIFICATIONS_HASH} onClick={() => setOpen(false)} className={cx("rounded text-xs text-emerald-300 hover:underline", focusRing)}>
              See all
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
