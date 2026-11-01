import { NEW_PROJECT_HASH } from "../auth/navigation";

/** Opens the New project wizard from any GC screen. */
export function requestNewProject(): void {
  window.location.hash = NEW_PROJECT_HASH;
}
