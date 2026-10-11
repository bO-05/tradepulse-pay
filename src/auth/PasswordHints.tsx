import { Check, Circle } from "lucide-react";
import { passwordChecks } from "../../convex/lib/passwordPolicy";
import { cx } from "../ui";

/** Live checklist for the shared password rule (convex/lib/passwordPolicy.ts). */
export function PasswordHints({ password, id }: { password: string; id: string }) {
  return (
    <ul id={id} aria-label="Password requirements" className="mt-1 space-y-1 text-xs">
      {passwordChecks(password).map((check) => (
        <li
          key={check.id}
          data-testid={`password-hint-${check.id}`}
          data-ok={check.ok ? "true" : "false"}
          className={cx("flex items-center gap-1.5", check.ok ? "text-emerald-300" : "text-ink-subtle")}
        >
          {check.ok ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : <Circle aria-hidden="true" className="h-3.5 w-3.5" />}
          <span>
            {check.label}
            <span className="sr-only">{check.ok ? " (done)" : " (not yet)"}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
