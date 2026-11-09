import { BUILD_COMMIT, BUILD_COMMIT_SHORT, BUILD_COMMIT_URL } from "../lib/buildInfo";
import { cx } from "./cx";

/** Visible on both static hosts; /version.json carries the same full commit. */
export function BuildStamp({ className }: { className?: string }) {
  return (
    <p className={cx("text-[11px] leading-relaxed text-slate-400", className)} data-testid="build-stamp">
      Build{" "}
      <a
        href={BUILD_COMMIT_URL ?? "/version.json"}
        title={BUILD_COMMIT}
        className="inline-flex min-h-6 items-center rounded underline decoration-slate-600 underline-offset-2 hover:text-slate-300"
      >
        {BUILD_COMMIT_SHORT}
      </a>{" "}
      · <a href="/version.json" className="inline-flex min-h-6 items-center rounded underline decoration-slate-600 underline-offset-2 hover:text-slate-300">version.json</a>
    </p>
  );
}
