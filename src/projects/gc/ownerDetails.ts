export type OwnerAddress = { line1: string; line2?: string; city: string; state: string; zip: string };

export type OwnerCompanyProfile = {
  name: string;
  legalName: string | null;
  phone: string | null;
  address: OwnerAddress | null;
  billingEmail: string | null;
};

export function formatOwnerAddress(a: OwnerAddress): string {
  return [a.line1, a.line2, `${a.city}, ${a.state} ${a.zip}`].filter(Boolean).join(", ");
}

/** The owner company rows a GC sees on the project page; unset profile fields read "Not set". */
export function ownerDetailRows(company: OwnerCompanyProfile): Array<{ label: string; value: string; testId: string }> {
  return [
    { label: "Company", value: company.name, testId: "owner-name" },
    { label: "Legal name", value: company.legalName || "Not set", testId: "owner-legal-name" },
    { label: "Address", value: company.address ? formatOwnerAddress(company.address) : "Not set", testId: "owner-address" },
    { label: "Phone", value: company.phone || "Not set", testId: "owner-phone" },
    { label: "Billing email", value: company.billingEmail ?? "Not set", testId: "owner-billing-email" },
  ];
}
