import type { ReactNode } from "react";
import { cx } from "./cx";
import { formatCents } from "./format";

export interface TableColumn<Row> {
  key: string;
  header: ReactNode;
  /** "money" columns are right-aligned with tabular digits; a number value is treated as cents. */
  kind?: "text" | "money" | "number";
  render?: (row: Row) => ReactNode;
  /** Used when `render` is omitted. */
  value?: (row: Row) => string | number | null | undefined;
  align?: "left" | "right" | "center";
  /** Plain-text header for the card layout when `header` is not a string. */
  cardLabel?: string;
  hideInCards?: boolean;
  className?: string;
}

export interface TableProps<Row> {
  columns: TableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /** Accessible table name. Visually hidden unless `showCaption`. */
  caption: string;
  showCaption?: boolean;
  empty?: ReactNode;
  /** Constrains the table height so the sticky header stays visible while the body scrolls. */
  maxHeight?: string;
  /** Column whose content titles each card in the mobile layout. Defaults to the first column. */
  cardTitleKey?: string;
  footer?: ReactNode;
  className?: string;
}

function alignment<Row>(col: TableColumn<Row>): "left" | "right" | "center" {
  if (col.align) return col.align;
  return col.kind === "money" || col.kind === "number" ? "right" : "left";
}

const ALIGN_CLASS = { left: "text-left", right: "text-right", center: "text-center" } as const;

function cellContent<Row>(col: TableColumn<Row>, row: Row): ReactNode {
  if (col.render) return col.render(row);
  const v = col.value?.(row);
  if (col.kind === "money" && typeof v === "number") return formatCents(v);
  if (v === null || v === undefined || v === "") return "—";
  return v;
}

/**
 * Data table with a sticky header and right-aligned money. Below 640px (`sm`) rows render as cards
 * so wide tables never cause horizontal page scroll.
 */
export function Table<Row>({
  columns,
  rows,
  rowKey,
  caption,
  showCaption = false,
  empty,
  maxHeight,
  cardTitleKey,
  footer,
  className,
}: TableProps<Row>) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  const titleCol = columns.find((c) => c.key === cardTitleKey) ?? columns[0];
  const cardCols = columns.filter((c) => c !== titleCol && !c.hideInCards);

  return (
    <div className={className}>
      <div
        className="hidden overflow-auto rounded-xl border border-line sm:block"
        style={maxHeight ? { maxHeight } : undefined}
      >
        <table className="w-full border-collapse text-sm">
          <caption className={showCaption ? "px-4 py-2 text-left text-sm font-semibold text-ink" : "sr-only"}>{caption}</caption>
          <thead className="sticky top-0 z-10 bg-surface-raised">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  className={cx(
                    "whitespace-nowrap border-b border-line px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-ink-muted",
                    ALIGN_CLASS[alignment(col)],
                    col.className,
                  )}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line bg-surface">
            {rows.map((row) => (
              <tr key={rowKey(row)} className="hover:bg-surface-raised/60">
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cx(
                      "px-4 py-2.5 text-ink",
                      ALIGN_CLASS[alignment(col)],
                      (col.kind === "money" || col.kind === "number") && "whitespace-nowrap tabular-nums",
                      col.className,
                    )}
                  >
                    {cellContent(col, row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {footer && <tfoot className="border-t border-line-strong bg-surface-raised">{footer}</tfoot>}
        </table>
      </div>

      <ul aria-label={caption} className="space-y-3 sm:hidden">
        {rows.map((row) => (
          <li key={rowKey(row)} className="rounded-xl border border-line bg-surface p-4">
            {titleCol && <div className="mb-2 font-semibold text-ink">{cellContent(titleCol, row)}</div>}
            <dl className="space-y-1.5 text-sm">
              {cardCols.map((col) => (
                <div key={col.key} className="flex items-start justify-between gap-4">
                  <dt className="text-ink-subtle">{col.cardLabel ?? (typeof col.header === "string" ? col.header : col.key)}</dt>
                  <dd
                    className={cx(
                      "min-w-0 break-words text-right text-ink",
                      (col.kind === "money" || col.kind === "number") && "tabular-nums",
                    )}
                  >
                    {cellContent(col, row)}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
