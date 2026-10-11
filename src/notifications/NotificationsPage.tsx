import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Button, Card, EmptyState, PageHeader } from "../ui";
import { NotificationItem } from "./NotificationItem";

const PAGE_SIZE = 25;

export function NotificationsPage() {
  const { results, status, loadMore } = usePaginatedQuery(api.notifications.list, {}, { initialNumItems: PAGE_SIZE });
  const summary = useQuery(api.notifications.summary, {});
  const markAllRead = useMutation(api.notifications.markAllRead);
  const unread = summary?.unreadCount ?? 0;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="Notifications"
        description="Activity for your company. Notifications are in-app only."
        actions={
          unread > 0 ? (
            <Button variant="secondary" size="sm" onClick={() => void markAllRead({})}>
              Mark all as read
            </Button>
          ) : undefined
        }
      />
      {status === "LoadingFirstPage" ? (
        <p className="text-sm text-slate-400">Loading notifications…</p>
      ) : results.length === 0 ? (
        <EmptyState title="You're all caught up" description="New activity for your company shows up here." />
      ) : (
        <Card padded={false}>
          <ul>
            {results.map((n) => (
              <NotificationItem key={n._id} n={n} />
            ))}
          </ul>
        </Card>
      )}
      {status === "CanLoadMore" && (
        <Button variant="secondary" onClick={() => loadMore(PAGE_SIZE)}>
          Show older notifications
        </Button>
      )}
    </div>
  );
}
