import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { getErrorMessage } from "../lib/errors";
import { cx } from "./cx";
import { IconButton } from "./IconButton";

export type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface ToastApi {
  success: (message: string) => void;
  /** Accepts a message or an error; ConvexError messages are shown instead of "Server Error". */
  error: (messageOrError: unknown, fallback?: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const DURATION_MS: Record<ToastKind, number> = { success: 5000, info: 5000, error: 8000 };

const KIND_STYLE: Record<ToastKind, string> = {
  success: "border-emerald-800 bg-emerald-950 text-emerald-100",
  error: "border-rose-800 bg-rose-950 text-rose-100",
  info: "border-sky-800 bg-sky-950 text-sky-100",
};

const KIND_ICON: Record<ToastKind, ReactNode> = {
  success: <CheckCircle2 className="h-5 w-5" />,
  error: <XCircle className="h-5 w-5" />,
  info: <Info className="h-5 w-5" />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++;
      setItems((list) => [...list.slice(-3), { id, kind, message }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DURATION_MS[kind]),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => clearTimeout(t));
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push("success", m),
      info: (m) => push("info", m),
      error: (e, fallback) => push("error", typeof e === "string" ? e : getErrorMessage(e, fallback)),
    }),
    [push],
  );

  const renderList = (kinds: ToastKind[]) =>
    items
      .filter((t) => kinds.includes(t.kind))
      .map((t) => (
        <div
          key={t.id}
          className={cx("pointer-events-auto flex w-full items-start gap-3 rounded-xl border p-3 pr-1 text-sm shadow-lg", KIND_STYLE[t.kind])}
        >
          <span aria-hidden="true" className="mt-0.5">
            {KIND_ICON[t.kind]}
          </span>
          <p className="flex-1 py-0.5">{t.message}</p>
          <IconButton label="Dismiss notification" size="sm" icon={<X className="h-4 w-4" />} onClick={() => dismiss(t.id)} className="text-current hover:bg-white/10 hover:text-current" />
        </div>
      ));

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-toast flex flex-col items-center gap-2 p-4 sm:items-end">
        <div role="status" aria-live="polite" className="flex w-full max-w-sm flex-col gap-2">
          {renderList(["success", "info"])}
        </div>
        <div role="alert" aria-live="assertive" className="flex w-full max-w-sm flex-col gap-2">
          {renderList(["error"])}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>.");
  return ctx;
}
