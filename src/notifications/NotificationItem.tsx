import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { cx, focusRing } from "../ui";
import { formatDateTime } from "../ui/format";

export type NotificationRow = {
  _id: string;
  title: string;
  body: string;
  link: string;
  read: boolean;
  createdAt: number;
};

const MINUTE = 60_000;

/** "just now", "5 min ago", "3 h ago", then the formatted date and time. */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  if (diff < MINUTE) return "just now";
  if (diff < 60 * MINUTE) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < 24 * 60 * MINUTE) return `${Math.floor(diff / (60 * MINUTE))} h ago`;
  return formatDateTime(ts);
}

/** One notification: opening it marks it read and goes to its link; "Mark as read" only marks it. */
export function NotificationItem({ n, onOpen }: { n: NotificationRow; onOpen?: () => void }) {
  const markRead = useMutation(api.notifications.markRead);
  const open = () => {
    if (!n.read) void markRead({ notificationId: n._id }).catch(() => undefined);
    onOpen?.();
    window.location.hash = n.link;
  };
  return (
    <li
      className={cx("flex items-start gap-2 border-b border-line px-3 py-2.5 last:border-b-0", n.read ? "" : "bg-emerald-950/30")}
      data-unread={n.read ? undefined : "true"}
    >
      <span
        aria-hidden="true"
        className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-emerald-400")}
      />
      <button type="button" onClick={open} className={cx("min-w-0 flex-1 rounded text-left", focusRing)}>
        <span className={cx("block text-sm", n.read ? "text-ink-muted" : "font-semibold text-ink")}>
          {n.title}
          {!n.read && <span className="sr-only"> (unread)</span>}
        </span>
        <span className="mt-0.5 block text-xs text-ink-subtle">{n.body}</span>
        <time dateTime={new Date(n.createdAt).toISOString()} title={formatDateTime(n.createdAt)} className="mt-1 block text-[11px] text-ink-subtle">
          {relativeTime(n.createdAt)}
        </time>
      </button>
      {!n.read && (
        <button
          type="button"
          onClick={() => void markRead({ notificationId: n._id })}
          className={cx("shrink-0 rounded px-1.5 py-1 text-[11px] text-emerald-300 hover:bg-surface-raised", focusRing)}
          aria-label={`Mark as read: ${n.title}`}
        >
          Mark as read
        </button>
      )}
    </li>
  );
}
