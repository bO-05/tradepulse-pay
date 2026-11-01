import { useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useDialogFocus, useEscapeToClose } from "../lib/useDialogFocus";
import { IconButton } from "./IconButton";

export interface DialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Buttons row; rendered under the body. */
  footer?: ReactNode;
}

/** Modal form dialog (focus trapped, Escape closes). Use ConfirmDialog for irreversible actions. */
export function Dialog({ open, title, description, onClose, children, footer }: DialogProps) {
  const ref = useDialogFocus<HTMLDivElement>(open);
  const titleId = useId();
  useEscapeToClose(open, onClose);
  if (!open) return null;
  return createPortal(
    <div
      role="presentation"
      className="fixed inset-0 z-dialog flex items-end justify-center bg-black/75 p-4 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line bg-surface-overlay p-5 shadow-2xl outline-none"
      >
        <div className="flex items-start gap-3">
          <h2 id={titleId} className="flex-1 text-base font-semibold text-ink">
            {title}
          </h2>
          <IconButton label="Close" size="sm" icon={<X className="h-4 w-4" />} onClick={onClose} className="-mr-2 -mt-2" />
        </div>
        {description && <div className="mt-1 text-sm text-ink-subtle">{description}</div>}
        <div className="mt-4">{children}</div>
        {footer && <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
