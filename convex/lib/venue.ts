/**
 * Dispute venue for a project: city + county + state. The county comes from a small table of
 * common cities; unknown cities fall back to "the county in which the Project is located".
 */
import { stateName } from "./agreementTerms";

const COUNTIES: Record<string, Record<string, string>> = {
  AZ: {
    phoenix: "Maricopa", scottsdale: "Maricopa", tempe: "Maricopa", mesa: "Maricopa", chandler: "Maricopa",
    gilbert: "Maricopa", glendale: "Maricopa", peoria: "Maricopa", tucson: "Pima", flagstaff: "Coconino",
  },
  CA: {
    oakland: "Alameda", berkeley: "Alameda", fremont: "Alameda", hayward: "Alameda", emeryville: "Alameda",
    alameda: "Alameda", "san leandro": "Alameda", "san francisco": "San Francisco", "san jose": "Santa Clara",
    "palo alto": "Santa Clara", "santa clara": "Santa Clara", sunnyvale: "Santa Clara", "mountain view": "Santa Clara",
    "los angeles": "Los Angeles", "long beach": "Los Angeles", pasadena: "Los Angeles", "santa monica": "Los Angeles",
    "san diego": "San Diego", sacramento: "Sacramento", fresno: "Fresno", irvine: "Orange", anaheim: "Orange",
    "santa ana": "Orange", riverside: "Riverside", "walnut creek": "Contra Costa", richmond: "Contra Costa",
    "san mateo": "San Mateo", "redwood city": "San Mateo",
  },
  CO: { denver: "Denver", boulder: "Boulder", "colorado springs": "El Paso", aurora: "Arapahoe" },
  FL: { miami: "Miami-Dade", orlando: "Orange", tampa: "Hillsborough", jacksonville: "Duval" },
  GA: { atlanta: "Fulton" },
  IL: { chicago: "Cook" },
  NV: { "las vegas": "Clark", henderson: "Clark", reno: "Washoe" },
  NY: { "new york": "New York", brooklyn: "Kings", buffalo: "Erie" },
  OR: { portland: "Multnomah", salem: "Marion", eugene: "Lane" },
  TX: { austin: "Travis", dallas: "Dallas", houston: "Harris", "san antonio": "Bexar", "fort worth": "Tarrant" },
  WA: { seattle: "King", bellevue: "King", tacoma: "Pierce", spokane: "Spokane" },
};

export type Venue = { city: string | null; county: string | null; state: string | null; stateName: string | null };

export function venueFor(city: string | null | undefined, state: string | null | undefined): Venue {
  const code = state ? state.trim().toUpperCase() : null;
  const name = stateName(code);
  const cleanCity = city?.trim() || null;
  const county = cleanCity && code ? COUNTIES[code]?.[cleanCity.toLowerCase()] ?? null : null;
  return { city: cleanCity, county: county ? `${county} County` : null, state: name ? code : null, stateName: name };
}

/** "Oakland, Alameda County, California" or a generic description when parts are unknown. */
export function venueText(venue: Venue): string {
  const where = venue.stateName ? `, ${venue.stateName}` : "";
  if (venue.county && venue.city) return `${venue.city}, ${venue.county}${where}`;
  if (venue.city) return `the county in which the Project is located (${venue.city}${where})`;
  return venue.stateName ? `the county in which the Project is located, ${venue.stateName}` : "the county in which the Project is located";
}
