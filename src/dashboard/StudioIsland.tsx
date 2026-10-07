import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * Renders children in a separate React root, outside the app's <StrictMode>.
 * AG Studio's React grid widgets (Table, Pivot Table) mount empty when StrictMode double-invokes
 * their effects in development; the production build is unaffected. Children here must not need
 * app context (Convex, auth), so data is passed in as props.
 */
export function StudioIsland({ children, className, style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<Root | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const container = document.createElement("div");
    container.style.height = "100%";
    host.appendChild(container);
    const r = createRoot(container);
    setRoot(r);
    return () => {
      setRoot(null);
      // Unmounting synchronously while the outer root is rendering triggers a React warning.
      setTimeout(() => {
        r.unmount();
        container.remove();
      }, 0);
    };
  }, []);

  useEffect(() => {
    root?.render(children);
  }, [root, children]);

  return <div ref={hostRef} className={className} style={style} />;
}
