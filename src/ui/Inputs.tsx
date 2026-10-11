import { forwardRef, useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";
import { Field, inputClass } from "./Field";
import { formatCents } from "./format";
import {
  bpsToEditableText,
  centsToEditableText,
  maskMoneyInput,
  maskPercentInput,
  maskedNumberChange,
  parseMoneyToCents,
  parsePercentToBps,
} from "./masks";

interface BaseFieldProps {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  id?: string;
  className?: string;
}

type NativeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "required" | "className" | "value" | "onChange" | "type">;

export interface TextInputProps extends BaseFieldProps, NativeInputProps {
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "tel" | "url" | "password" | "search";
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { label, required, hint, error, id, className, value, onChange, type = "text", ...rest },
  ref,
) {
  return (
    <Field label={label} required={required} hint={hint} error={error} id={id} className={className}>
      {(control) => (
        <input
          ref={ref}
          {...rest}
          {...control}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass(Boolean(error))}
        />
      )}
    </Field>
  );
});

/** Shared behavior for masked numeric inputs: filter keystrokes, parse strictly, format on blur. */
function useMaskedNumber(options: {
  value: number | null;
  onChange: (value: number | null) => void;
  toEditable: (v: number | null) => string;
  toDisplay: (v: number | null) => string;
  mask: (raw: string) => { text: string; rejected: boolean };
  parse: (text: string) => { ok: true; value: number | null } | { ok: false; error: string };
  rejectMessage: string;
  onInvalidChange?: (error: string | null) => void;
}) {
  const { value, onChange, toEditable, toDisplay, mask, parse, rejectMessage, onInvalidChange } = options;
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState(() => toDisplay(value));
  const [localError, setLocalError] = useState<string | null>(null);
  // Set when the last edit contained characters the mask removed ("12,40a", "-5000"): the filtered
  // text must not silently become a valid amount, so the value stays null until the user edits again.
  const [rejected, setRejected] = useState(false);
  const lastEmitted = useRef<number | null>(value);
  const lastInvalid = useRef<string | null>(null);
  const reportInvalid = (error: string | null) => {
    if (lastInvalid.current === error) return;
    lastInvalid.current = error;
    onInvalidChange?.(error);
  };

  useEffect(() => {
    if (!focused && value !== lastEmitted.current) {
      lastEmitted.current = value;
      setText(toDisplay(value));
      setRejected(false);
      setLocalError(null);
      reportInvalid(null);
    }
  }, [focused, value, toDisplay]);

  const emit = (v: number | null) => {
    lastEmitted.current = v;
    onChange(v);
  };

  return {
    text,
    localError,
    onFocus: () => {
      setFocused(true);
      // Invalid text stays visible next to its error instead of being replaced by the empty value.
      if (lastInvalid.current === null) setText(toEditable(value));
    },
    onBlur: () => {
      setFocused(false);
      if (rejected) return;
      const parsed = parse(text);
      if (parsed.ok) {
        setText(toDisplay(parsed.value));
        setLocalError(null);
      } else {
        setLocalError(parsed.error);
      }
    },
    onChange: (raw: string) => {
      const change = maskedNumberChange(raw, mask, parse, rejectMessage);
      setText(change.text);
      setRejected(mask(raw).rejected);
      setLocalError(change.showWhileTyping ? change.invalid : null);
      reportInvalid(change.invalid);
      emit(change.value);
    },
  };
}

export interface MoneyInputProps extends BaseFieldProps, Omit<NativeInputProps, "onBlur" | "onFocus"> {
  /** Integer cents, or null when empty. */
  value: number | null;
  onChange: (cents: number | null) => void;
  /** Only change-order amounts may be negative. */
  allowNegative?: boolean;
  /** Called with the reason the typed text is invalid, or null once it is valid or empty. */
  onInvalidChange?: (error: string | null) => void;
}

const toEditableCents = (v: number | null) => centsToEditableText(v);
const toDisplayCents = (v: number | null) => (v === null ? "" : formatCents(v));

export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
  { label, required, hint, error, id, className, value, onChange, allowNegative = false, placeholder, onInvalidChange, ...rest },
  ref,
) {
  const masked = useMaskedNumber({
    value,
    onChange,
    toEditable: toEditableCents,
    toDisplay: toDisplayCents,
    mask: (raw) => maskMoneyInput(raw, { allowNegative }),
    parse: (text) => parseMoneyToCents(text, { allowNegative }),
    rejectMessage: allowNegative
      ? "Use numbers only, with up to two decimals."
      : "Use numbers only, with up to two decimals. Negative amounts aren't allowed.",
    onInvalidChange,
  });
  const shownError = masked.localError ?? error ?? undefined;
  return (
    <Field label={label} required={required} hint={hint} error={shownError} id={id} className={className}>
      {(control) => (
        <input
          ref={ref}
          {...rest}
          {...control}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder={placeholder ?? "$0.00"}
          value={masked.text}
          onFocus={masked.onFocus}
          onBlur={masked.onBlur}
          onChange={(e) => masked.onChange(e.target.value)}
          className={inputClass(Boolean(shownError), "text-right tabular-nums")}
        />
      )}
    </Field>
  );
});

export interface PercentInputProps extends BaseFieldProps, Omit<NativeInputProps, "onBlur" | "onFocus"> {
  /** Basis points, or null when empty. */
  value: number | null;
  onChange: (bps: number | null) => void;
  /** Maximum percent (not bps); defaults to 100. */
  max?: number;
  /** Called with the reason the typed text is invalid, or null once it is valid or empty. */
  onInvalidChange?: (error: string | null) => void;
}

export const PercentInput = forwardRef<HTMLInputElement, PercentInputProps>(function PercentInput(
  { label, required, hint, error, id, className, value, onChange, max = 100, placeholder, onInvalidChange, ...rest },
  ref,
) {
  const masked = useMaskedNumber({
    value,
    onChange,
    toEditable: bpsToEditableText,
    toDisplay: bpsToEditableText,
    mask: maskPercentInput,
    parse: (text) => parsePercentToBps(text, { max }),
    rejectMessage: "Use numbers only, with up to two decimals.",
    onInvalidChange,
  });
  const shownError = masked.localError ?? error ?? undefined;
  return (
    <Field label={label} required={required} hint={hint} error={shownError} id={id} className={className}>
      {(control) => (
        <div className="relative">
          <input
            ref={ref}
            {...rest}
            {...control}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder={placeholder ?? "0"}
            value={masked.text}
            onFocus={masked.onFocus}
            onBlur={masked.onBlur}
            onChange={(e) => masked.onChange(e.target.value)}
            className={inputClass(Boolean(shownError), "pr-8 text-right tabular-nums")}
          />
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-ink-subtle">
            %
          </span>
        </div>
      )}
    </Field>
  );
});

export interface DateInputProps extends BaseFieldProps, NativeInputProps {
  /** Calendar date `YYYY-MM-DD`, or "" when empty. */
  value: string;
  onChange: (value: string) => void;
}

export const DateInput = forwardRef<HTMLInputElement, DateInputProps>(function DateInput(
  { label, required, hint, error, id, className, value, onChange, ...rest },
  ref,
) {
  return (
    <Field label={label} required={required} hint={hint} error={error} id={id} className={className}>
      {(control) => (
        <input
          ref={ref}
          {...rest}
          {...control}
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cx(inputClass(Boolean(error)), "[color-scheme:dark]")}
        />
      )}
    </Field>
  );
});

export interface TimeInputProps extends BaseFieldProps, NativeInputProps {
  /** 24-hour `HH:MM`, or "" when empty. */
  value: string;
  onChange: (value: string) => void;
}

export const TimeInput = forwardRef<HTMLInputElement, TimeInputProps>(function TimeInput(
  { label, required, hint, error, id, className, value, onChange, ...rest },
  ref,
) {
  return (
    <Field label={label} required={required} hint={hint} error={error} id={id} className={className}>
      {(control) => (
        <input
          ref={ref}
          {...rest}
          {...control}
          type="time"
          step={60}
          value={value}
          onChange={(e) => onChange(e.target.value.slice(0, 5))}
          className={cx(inputClass(Boolean(error)), "[color-scheme:dark]")}
        />
      )}
    </Field>
  );
});
