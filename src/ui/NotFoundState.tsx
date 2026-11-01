import { createContext, useContext, type MouseEvent } from "react";
import { cx } from "./cx";

export const NOT_FOUND_TITLE = "Not found";
export const NOT_FOUND_MESSAGE = "This page does not exist or you don't have access to it.";

export type NotFoundHome = { href: string; label: string };

/** The signed-in role's home; the app shell provides it so every Not found page links to the same place. */
export const NotFoundHomeContext = createContext<NotFoundHome>({ href: "#/", label: "Home" });

export interface NotFoundStateProps {
  /** For screens whose URL state lives outside the hash (for example `?project=`), so the link must also reset it. */
  onHome?: () => void;
  className?: string;
}

/**
 * The single page shown for missing records, records the caller may not access, unknown routes and
 * routes the caller's role or company cannot open. Every case renders the same text so a forbidden
 * record is indistinguishable from a missing one.
 */
export function NotFoundState({ onHome, className }: NotFoundStateProps) {
  const home = useContext(NotFoundHomeContext);
  const handleClick = onHome
    ? (event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        onHome();
      }
    : undefined;
  return (
    <div
      role="alert"
      data-testid="not-found"
      className={cx("max-w-xl rounded-2xl border border-slate-700 bg-slate-900/60 p-6", className)}
    >
      <h1 className="text-lg font-semibold text-slate-100">{NOT_FOUND_TITLE}</h1>
      <p className="mt-2 text-sm text-slate-300">{NOT_FOUND_MESSAGE}</p>
      <a href={home.href} onClick={handleClick} className="mt-3 inline-block text-sm text-emerald-300 underline">
        Back to {home.label}
      </a>
    </div>
  );
}
