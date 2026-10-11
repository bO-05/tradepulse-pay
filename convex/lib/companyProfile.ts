/** Company profile rules shared by the onboarding form and `onboarding.createCompany`. Pure TS. */

export const US_STATES: ReadonlyArray<{ code: string; name: string }> = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"],
  ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["DC", "District of Columbia"],
  ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"],
  ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"],
  ["ME", "Maine"], ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"],
  ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"],
  ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"],
  ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"],
  ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"], ["SD", "South Dakota"],
  ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"],
  ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
].map(([code, name]) => ({ code, name }));

const STATE_CODES = new Set(US_STATES.map((s) => s.code));

export interface CompanyProfileInput {
  name: string;
  address: { line1: string; line2?: string; city: string; state: string; zip: string };
  phone: string;
}

export type CompanyProfileField = "name" | "line1" | "city" | "state" | "zip" | "phone";
export type CompanyProfileErrors = Partial<Record<CompanyProfileField, string>>;

export function phoneDigits(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/** "(510) 555-0187" for a 10-digit US number. */
export function formatUsPhone(phone: string): string {
  const d = phoneDigits(phone);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : phone.trim();
}

export function validateCompanyProfile(input: CompanyProfileInput): CompanyProfileErrors {
  const errors: CompanyProfileErrors = {};
  const name = input.name.trim();
  if (name.length === 0) errors.name = "Enter your company name.";
  else if (name.length < 2) errors.name = "Company name must be at least 2 characters.";
  else if (name.length > 120) errors.name = "Company name must be at most 120 characters.";
  if (input.address.line1.trim().length === 0) errors.line1 = "Enter the street address.";
  else if (input.address.line1.trim().length > 200) errors.line1 = "Street address is too long.";
  if (input.address.city.trim().length === 0) errors.city = "Enter the city.";
  else if (input.address.city.trim().length > 100) errors.city = "City is too long.";
  if (!STATE_CODES.has(input.address.state.trim().toUpperCase())) errors.state = "Choose a state.";
  if (!/^\d{5}(-\d{4})?$/.test(input.address.zip.trim())) errors.zip = "Enter a 5-digit ZIP code.";
  if (phoneDigits(input.phone).length !== 10) errors.phone = "Enter a 10-digit US phone number.";
  return errors;
}

/** Trimmed, canonical values to store (state upper-case, phone formatted). */
export function normalizeCompanyProfile(input: CompanyProfileInput): CompanyProfileInput {
  const line2 = input.address.line2?.trim();
  return {
    name: input.name.trim().replace(/\s+/g, " "),
    address: {
      line1: input.address.line1.trim(),
      ...(line2 ? { line2 } : {}),
      city: input.address.city.trim(),
      state: input.address.state.trim().toUpperCase(),
      zip: input.address.zip.trim(),
    },
    phone: formatUsPhone(input.phone),
  };
}
