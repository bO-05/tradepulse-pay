import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { useAction } from "convex/react";
import { ConvexError } from "convex/values";
import { useState, type ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { formatCents, formatDate } from "./format";

export type MilestoneFunding = {
  paymentId: string;
  status: string;
  grossCents: number;
  paypalOrderId: string | null;
  paypalAuthorizationId: string | null;
  authorizationExpiresAt: number | null;
  honorPeriodEndsAt: number | null;
  capturedCents?: number;
  error: string | null;
} | null;

export type FundableMilestone = {
  _id: Id<"milestones">;
  name: string;
  amountCents: number;
  status: string;
  funding: MilestoneFunding;
};

const PAYPAL_CLIENT_ID = import.meta.env.VITE_PAYPAL_CLIENT_ID as string | undefined;
const FUNDABLE = new Set(["planned", "funding", "funding_expired"]);

/** Readable text for errors thrown by Convex actions (ConvexError data.message) or the PayPal SDK. */
export function readableError(e: unknown): string {
  if (e instanceof ConvexError) {
    const data = e.data as { message?: unknown } | string;
    if (typeof data === "string") return data;
    if (typeof data?.message === "string") return data.message;
  }
  if (e instanceof Error && e.message) return e.message;
  return "Something went wrong while funding this milestone.";
}

/** Loads the PayPal JS SDK (sandbox client id, AUTHORIZE intent) for the funding controls below it. */
export function FundingProvider({ children }: { children: ReactNode }) {
  if (!PAYPAL_CLIENT_ID) return <>{children}</>;
  return (
    <PayPalScriptProvider options={{ clientId: PAYPAL_CLIENT_ID, intent: "authorize", currency: "USD", components: "buttons" }}>
      {children}
    </PayPalScriptProvider>
  );
}

/** Funding state text shown to every role. */
export function FundingStatus({ milestone }: { milestone: FundableMilestone }) {
  const f = milestone.funding;
  if (f === null) return <span className="text-xs text-slate-500">Not funded</span>;
  if (f.paypalAuthorizationId && (f.status === "partially_captured" || f.status === "captured" || f.status === "voided")) {
    const captured = formatCents(f.capturedCents ?? 0);
    const text =
      f.status === "partially_captured"
        ? `Captured ${captured} of ${formatCents(f.grossCents)} authorized`
        : f.status === "captured"
          ? `Fully captured ${captured}`
          : `Closed: captured ${captured}, remainder voided`;
    return (
      <span className="text-xs text-emerald-300" data-testid="milestone-funding">
        {text}
      </span>
    );
  }
  if (f.paypalAuthorizationId) {
    return (
      <span className="text-xs text-emerald-300" data-testid="milestone-funding">
        Authorized {formatCents(f.grossCents)} · honor period ends {formatDate(f.honorPeriodEndsAt)} · expires{" "}
        {formatDate(f.authorizationExpiresAt)}
      </span>
    );
  }
  if (f.status === "failed" && f.error) {
    return (
      <span className="text-xs text-rose-300" data-testid="milestone-funding">
        Last attempt failed
      </span>
    );
  }
  if (f.status === "approved") {
    return (
      <span className="text-xs text-amber-300" data-testid="milestone-funding">
        Approved, authorizing…
      </span>
    );
  }
  return (
    <span className="text-xs text-slate-400" data-testid="milestone-funding">
      {f.status === "created" ? "Checkout started" : f.status}
    </span>
  );
}

/** GC-only "Fund" control: opens the PayPal buttons; createOrder/onApprove call Convex actions. */
export function FundMilestoneControl({ milestone }: { milestone: FundableMilestone }) {
  const createFundingOrder = useAction(api.payments.orders.createFundingOrder);
  const authorizeFundingOrder = useAction(api.payments.orders.authorizeFundingOrder);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!FUNDABLE.has(milestone.status) || milestone.funding?.paypalAuthorizationId) return null;

  const storedError = milestone.funding?.status === "failed" ? milestone.funding.error : null;
  const shownError = error ?? storedError;
  const pendingApproval = milestone.funding?.status === "approved" ? milestone.funding.paypalOrderId : null;

  async function authorize(orderId: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await authorizeFundingOrder({ orderId });
      setOpen(false);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="fund-control">
      {!open && (
        <button
          type="button"
          data-testid="fund-milestone-button"
          disabled={busy || pendingApproval !== null}
          onClick={() => {
            setOpen(true);
            setError(null);
            setNotice(null);
          }}
          className="text-xs font-semibold rounded-lg px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Fund {formatCents(milestone.amountCents)}
        </button>
      )}
      {pendingApproval !== null && (
        <button
          type="button"
          data-testid="retry-authorization-button"
          disabled={busy}
          onClick={() => void authorize(pendingApproval)}
          className="text-xs rounded-lg px-3 py-1.5 border border-amber-700 text-amber-200 disabled:opacity-50"
        >
          Retry authorization
        </button>
      )}
      {open && (
        <div className="bg-white rounded-xl p-3 w-72 space-y-2" data-testid="paypal-buttons">
          {!PAYPAL_CLIENT_ID ? (
            <p className="text-xs text-rose-700">PayPal is not configured (VITE_PAYPAL_CLIENT_ID is missing).</p>
          ) : (
            <PayPalButtons
              style={{ layout: "vertical", label: "pay" }}
              disabled={busy}
              forceReRender={[milestone._id]}
              createOrder={async () => {
                setError(null);
                setNotice(null);
                try {
                  const { orderId } = await createFundingOrder({ milestoneId: milestone._id });
                  return orderId;
                } catch (e) {
                  setError(readableError(e));
                  throw e;
                }
              }}
              onApprove={async (data) => {
                await authorize(data.orderID);
              }}
              onCancel={() => setNotice("Checkout was cancelled. The milestone is not funded.")}
              onError={(e) => {
                setError((prev) => prev ?? readableError(e));
              }}
            />
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={busy}
            className="text-xs text-slate-600 hover:text-slate-900"
          >
            Close
          </button>
        </div>
      )}
      {busy && (
        <p className="text-xs text-slate-300" role="status">
          Authorizing with PayPal…
        </p>
      )}
      {notice && <p className="text-xs text-slate-300">{notice}</p>}
      {shownError && (
        <p className="text-xs text-rose-300 max-w-xs" role="alert" data-testid="funding-error">
          {shownError}
        </p>
      )}
    </div>
  );
}
