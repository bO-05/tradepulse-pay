import { Component, type ReactNode } from "react";
import { getErrorMessage } from "./errors";

/**
 * Convex `useQuery` throws server errors during render. This shows them as a readable message
 * (e.g. "Not found.") instead of blanking the app. `resetKey` clears the error when it changes.
 */
export class QueryBoundary extends Component<
  { children: ReactNode; resetKey?: string; fallback?: (message: string) => ReactNode },
  { message: string | null; key?: string }
> {
  state: { message: string | null; key?: string } = { message: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown) {
    return { message: getErrorMessage(error, "This page couldn't be loaded.") };
  }

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { message: string | null; key?: string }) {
    if (props.resetKey !== state.key) return { message: null, key: props.resetKey };
    return null;
  }

  render() {
    if (this.state.message !== null) {
      if (this.props.fallback) return this.props.fallback(this.state.message);
      return (
        <div role="alert" className="max-w-xl rounded-2xl border border-rose-800 bg-rose-950/40 p-6 text-sm text-rose-100">
          {this.state.message}
        </div>
      );
    }
    return this.props.children;
  }
}
