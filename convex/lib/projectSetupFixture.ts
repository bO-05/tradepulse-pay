/** Valid `projects.createProject` arguments for tests (a TX project, so 10% retainage is allowed). */
export function projectSetupArgs(overrides: Record<string, unknown> & { title?: string } = {}) {
  return {
    title: "Fixture Project",
    ownerName: "Fixture Owner LLC",
    address: { line1: "100 Congress Ave", city: "Austin", zip: "78701" },
    state: "TX",
    contractValueCents: 250_000_000,
    retainageBps: 1000,
    billingDay: 25,
    startDate: "2026-10-01",
    ...overrides,
  };
}
