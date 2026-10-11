import { inflate } from "pako";
import { roundDollarsToCents } from "../../convex/lib/money.ts";

export function extractTextFromPdfStream(rawInput: string | Uint8Array): string {
  if (!rawInput) return "";
  let buf: Uint8Array;
  let rawStr = "";

  if (typeof rawInput === "string") {
    rawStr = rawInput;
    const trimmedLeading = rawStr.replace(/^\uFEFF/, "").trimStart();
    if (!trimmedLeading.startsWith("%PDF") && !rawStr.includes("%PDF-") && !/[\x00-\x08\x0E-\x1F]/.test(rawStr.slice(0, 200))) {
      return rawStr;
    }
    buf = new Uint8Array(rawStr.length);
    for (let i = 0; i < rawStr.length; i++) {
      buf[i] = rawStr.charCodeAt(i) & 0xff;
    }
  } else if (rawInput instanceof Uint8Array) {
    buf = rawInput;
    let s = "";
    const len = Math.min(buf.length, 500);
    for (let i = 0; i < len; i++) s += String.fromCharCode(buf[i]);
    rawStr = s;
    const trimmedLeading = rawStr.replace(/^\uFEFF/, "").trimStart();
    if (!trimmedLeading.startsWith("%PDF") && !rawStr.includes("%PDF-") && !/[\x00-\x08\x0E-\x1F]/.test(rawStr.slice(0, 200))) {
      let fullStr = "";
      for (let i = 0; i < buf.length; i++) fullStr += String.fromCharCode(buf[i]);
      return fullStr;
    }
    let fullS = "";
    for (let i = 0; i < buf.length; i++) fullS += String.fromCharCode(buf[i]);
    rawStr = fullS;
  } else {
    return "";
  }

  // Detect encrypted / password-protected PDF streams
  if (rawStr.includes("/Encrypt") && (/\/Encrypt\s+\d+\s+\d+\s+R/i.test(rawStr) || /\/Filter\s*\/Standard/i.test(rawStr))) {
    return "[PDF_ENCRYPTED] Password-protected or encrypted PDF proposal detected. Please export an unencrypted copy.";
  }

  // Detect corrupted or truncated PDF stream
  if ((rawStr.startsWith("%PDF") && !rawStr.includes("%%EOF") && rawStr.length < 150) ||
      (rawStr.startsWith("%PDF") && !rawStr.includes("obj") && !rawStr.includes("stream") && rawStr.length < 200)) {
    return "[PDF_CORRUPTED] Corrupted or incomplete PDF file structure.";
  }

  const extractedPieces: string[] = [];

  // Helper to decode PDF literal escape sequences including octal codes
  const decodePdfLiteral = (str: string): string => {
    return str
      .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\b/g, "\b")
      .replace(/\\f/g, "\f")
      .replace(/\\([()\\])/g, "$1");
  };

  // Helper to decode PDF hex strings <48656c6c6f>
  const decodePdfHex = (hex: string): string => {
    const cleanHex = hex.replace(/\s+/g, "");
    let out = "";
    for (let i = 0; i < cleanHex.length; i += 2) {
      const byte = parseInt(cleanHex.slice(i, i + 2), 16);
      if (!isNaN(byte) && byte >= 32 && byte <= 126) {
        out += String.fromCharCode(byte);
      } else if (byte === 10 || byte === 13 || byte === 9) {
        out += " ";
      }
    }
    return out;
  };

  const parseContentStream = (streamText: string) => {
    // 1. Extract from kerning arrays: [(item1) 20 (item2)] TJ
    const tjArrays = Array.from(streamText.matchAll(/\[([\s\S]*?)\]\s*TJ/g));
    for (const arr of tjArrays as any[]) {
      const innerParts: string[] = [];
      const tokens = Array.from(arr[1].matchAll(/\(([^)]+)\)|<([0-9a-fA-F]+)>/g));
      for (const token of tokens as any[]) {
        if (token[1] !== undefined) {
          innerParts.push(decodePdfLiteral(token[1]));
        } else if (token[2] !== undefined) {
          innerParts.push(decodePdfHex(token[2]));
        }
      }
      if (innerParts.length > 0) {
        extractedPieces.push(innerParts.join(""));
      }
    }

    // 2. Extract single literal text strings: (text string) Tj or '
    const simpleTj = Array.from(streamText.matchAll(/\(([^)]{1,})\)\s*(?:Tj|'|")/g)).map((m: any) =>
      decodePdfLiteral(m[1])
    );
    extractedPieces.push(...simpleTj);

    // 3. Extract standalone hex strings: <48656c6c6f> Tj
    const hexTj = Array.from(streamText.matchAll(/<([0-9a-fA-F]{2,})>\s*(?:Tj|'|")/g)).map((m: any) =>
      decodePdfHex(m[1])
    );
    extractedPieces.push(...hexTj);
  };

  // Find all streams in binary buffer
  let pos = 0;
  while (pos < buf.length) {
    // Search for "stream" (115, 116, 114, 101, 97, 109)
    let streamIdx = -1;
    for (let i = pos; i <= buf.length - 6; i++) {
      if (
        buf[i] === 115 &&
        buf[i + 1] === 116 &&
        buf[i + 2] === 114 &&
        buf[i + 3] === 101 &&
        buf[i + 4] === 97 &&
        buf[i + 5] === 109
      ) {
        streamIdx = i;
        break;
      }
    }
    if (streamIdx === -1) break;

    let startData = streamIdx + 6;
    if (buf[startData] === 0x0d && buf[startData + 1] === 0x0a) startData += 2;
    else if (buf[startData] === 0x0a) startData += 1;
    else if (buf[startData] === 0x0d) startData += 1;

    // Search for "endstream" (101, 110, 100, 115, 116, 114, 101, 97, 109)
    let endIdx = -1;
    for (let i = startData; i <= buf.length - 9; i++) {
      if (
        buf[i] === 101 &&
        buf[i + 1] === 110 &&
        buf[i + 2] === 100 &&
        buf[i + 3] === 115 &&
        buf[i + 4] === 116 &&
        buf[i + 5] === 114 &&
        buf[i + 6] === 101 &&
        buf[i + 7] === 97 &&
        buf[i + 8] === 109
      ) {
        endIdx = i;
        break;
      }
    }
    if (endIdx === -1) break;

    const streamBytes = buf.subarray(startData, endIdx);
    // Inspect preceding 300 bytes for /FlateDecode filter
    const prevStart = Math.max(0, streamIdx - 300);
    let prevHeader = "";
    for (let k = prevStart; k < streamIdx; k++) {
      prevHeader += String.fromCharCode(buf[k]);
    }

    if (prevHeader.includes("FlateDecode")) {
      try {
        const decompressed = inflate(streamBytes);
        let decStr = "";
        for (let d = 0; d < decompressed.length; d++) {
          decStr += String.fromCharCode(decompressed[d]);
        }
        parseContentStream(decStr);
      } catch {
        // Fallback if inflate fails
      }
    } else {
      let uncompStr = "";
      for (let u = 0; u < streamBytes.length; u++) {
        uncompStr += String.fromCharCode(streamBytes[u]);
      }
      parseContentStream(uncompStr);
    }
    pos = endIdx + 9;
  }

  // If no stream text extracted, check raw uncompressed text outside streams
  if (extractedPieces.length === 0) {
    parseContentStream(rawStr);
  }

  const extracted = extractedPieces.join("\n").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ").trim();

  // If we already extracted valid text (> 15 chars), return it directly to avoid binary contamination
  if (extracted.length > 15) {
    return extracted.slice(0, 32000);
  }

  // 3. Fallback token extraction: Strip binary stream contents first
  const textWithoutBinary = rawStr.replace(/stream[\r\n][\s\S]*?endstream/gi, "");
  const segments = textWithoutBinary.match(/[A-Za-z0-9\s.,;:$%/\\()\-–—@&+=#'"_[\]*!?]{4,}/g) || [];
  const cleanTokens = segments
    .filter((s: string) => {
      const trimmed = s.trim();
      return (
        !trimmed.startsWith("/") &&
        !trimmed.startsWith("obj") &&
        !trimmed.startsWith("endobj") &&
        !trimmed.startsWith("<<") &&
        !trimmed.startsWith(">>") &&
        !trimmed.includes("/Font") &&
        !trimmed.includes("/Type") &&
        !trimmed.includes("/Filter") &&
        !trimmed.includes("/FlateDecode") &&
        !trimmed.includes("/Length") &&
        !trimmed.includes("/XObject") &&
        !trimmed.includes("/Subtype") &&
        !trimmed.includes("/Image") &&
        !trimmed.includes("/Width") &&
        !trimmed.includes("/Height") &&
        !trimmed.includes("/ColorSpace") &&
        !trimmed.includes("/BitsPerComponent") &&
        !trimmed.includes("/Catalog") &&
        !trimmed.includes("/Pages") &&
        !trimmed.includes("/MediaBox") &&
        !/^(?:xref|trailer|startxref|stream|endstream|EOF|%%EOF|JFIF)$/i.test(trimmed)
      );
    })
    .join(" ")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
    .trim();

  // Only consider cleanTokens if it contains actual words, not just dictionary numbers/tokens
  const hasRealWords = /[a-zA-Z]{3,}\s+[a-zA-Z]{3,}/.test(cleanTokens);
  const candidateText = extracted.length > 15 ? extracted : (hasRealWords && cleanTokens.length > 30 ? cleanTokens : extracted);
  return candidateText.slice(0, 32000);
}

export function cleanNumber(val: any, fallback = 0): number {
  if (typeof val === "number") {
    return Number.isFinite(val) ? val : fallback;
  }
  if (!val) return fallback;
  if (typeof val !== "string") return fallback;

  // 1. Normalize unicode spaces & dashes
  let str = val
    .replace(/[\u00A0\u202F\u200B\u3000]/g, " ")
    .replace(/[\u2013\u2014]/g, "-")
    .trim();
  if (!str) return fallback;

  // 2. Check for range e.g. '$1,200,000 - $1,350,000' or '$1.2M to $1.4M' or 'between $1.2M and $1.4M'
  const withoutBetween = str.replace(/^between\s+/i, "");
  const rangeMatch = withoutBetween.match(/^(.+?)\s*(?:(?<=\S)\s*[-–—]\s*(?=\S)|\bto\b|\band\b)\s*(.+)$/i);
  if (rangeMatch) {
    let p1 = rangeMatch[1].trim();
    let p2 = rangeMatch[2].trim();
    if (/\d/.test(p1) && /\d/.test(p2) && !/^[+\-]/.test(p1.trim())) {
      const multRegex = /(k|kilo|thousand|m|mil|million|b|bil|billion)$/i;
      const p2Mult = p2.match(multRegex);
      if (p2Mult && !multRegex.test(p1)) {
        p1 = p1 + p2Mult[1];
      }
      const p2Curr = p2.match(/(USD|CAD|EUR|GBP|AUD|CHF|MXN|NZD|SGD)$/i);
      if (p2Curr && !new RegExp(p2Curr[1] + "$", "i").test(p1)) {
        p1 = p1 + " " + p2Curr[1];
      }
      const v1 = cleanNumber(p1, null as any);
      const v2 = cleanNumber(p2, null as any);
      if (v1 !== null && v2 !== null && v1 > 0 && v2 > 0) {
        return Math.round((v1 + v2) / 2);
      }
    }
  }

  // 3. Detect negative / deduct indicators
  const isDeductWord = /\b(?:deduct|deduction|credit|discount|savings|refund|rebate|less)\b/i.test(str);
  let isNegative =
    isDeductWord ||
    (str.startsWith("(") && str.endsWith(")")) ||
    str.startsWith("-") ||
    str.endsWith("-") ||
    /[-]\s*[$€£¥₹]/.test(str) ||
    /[$€£¥₹]\s*[-]/.test(str) ||
    /[-]\s*(?:USD|CAD|EUR|GBP|AUD|CHF|MXN|NZD|SGD)\b/i.test(str) ||
    /\b(?:USD|CAD|EUR|GBP|AUD|CHF|MXN|NZD|SGD)\s*[-]/i.test(str) ||
    /[-]\s*(?:USD|CAD|EUR|GBP|AUD|CHF|MXN|NZD|SGD)$/i.test(str);

  // 4. Strip common conversational / construction estimation prefixes
  str = str
    .replace(/^(?:[~≈*]|approx\.?|est\.?|estimated|budget:?|total:?|sum:?|quote:?|price:?|cost:?|amount:?)\s*/i, "")
    .replace(/^(?:addendum|alternate|option|item|ve|phase)?\s*#?\d*[:\s-]*(?:deduct(?:ion)?|credit|discount|savings|rebate|less):?\s*/i, "")
    .replace(/^(?:deduct(?:ion)?|credit|discount|savings|rebate|less)\s*(?:alternate|option|item|ve|phase)?\s*#?\d*[:\s-]*/i, "")
    .replace(/^(?:addendum|alternate|option|item|ve|phase)\s*#?\d*[:\s-]*/i, "")
    .replace(/^f\.?o\.?b\.?(?:\s*jobsite|\s*site)?:?\s*/i, "")
    .trim();

  // 5. Strip common commercial trailing qualifiers, taxes, and trade notations
  str = str
    .replace(/\s*(?:\+|\/|\bplus\b)?\s*(?:\d+(?:\.\d+)?%?\s*)?(?:sales\s*)?tax(?:es)?(?:\s*(?:extra|excluded|included|exempt|applicable|not\s+included))?/gi, "")
    .replace(/\s*\([^)]*(?:tax|phase|option|addendum|scope)[^)]*\)/gi, "")
    .replace(/\s*(?:\/|\bper\b)?\s*\b(?:lump\s*sum|ls|f\.?o\.?b\.?(?:\s*jobsite|\s*site)?|net\s*\d*|gross|delivered|installed|complete)\b/gi, "")
    .trim();

  // Strip trailing parenthetical notes EXCEPT if whole string is an accounting paren like ($35,000), ($25k), or (USD 50,000)
  const isWrappedInParens = str.startsWith("(") && str.endsWith(")");
  if (isWrappedInParens && /\d/.test(str) && !/\b(?:tax|phase|option|addendum|scope|exempt)\b/i.test(str)) {
    // Keep accounting negative intact
  } else {
    str = str.replace(/\s*\([^)]*\)$/, "").trim();
  }

  // 6. Remove wrapping parens, brackets, and signs
  str = str.replace(/^[(\[]+|[)\]]+$/g, "").replace(/^[-+]|[-+]$/g, "").trim();

  // 7. Strip currency symbols and ISO codes
  str = str
    .replace(/^(?:[$€£¥₹]|USD|CAD|EUR|GBP|AUD|CHF|MXN|NZD|SGD|\s)+/gi, "")
    .replace(/(?:[$€£¥₹]|USD|CAD|EUR|GBP|AUD|CHF|MXN|NZD|SGD|\s)+$/gi, "")
    .trim();

  // Re-check minus after currency strip (e.g. '$-25,000' -> '-25,000' or '25,000- USD' -> '25,000-')
  if (str.startsWith("-")) {
    isNegative = true;
    str = str.replace(/^-\s*/, "");
  }
  if (str.endsWith("-")) {
    isNegative = true;
    str = str.replace(/\s*-$/, "");
  }

  // 8. Check abbreviated multipliers (M, K, B, million, thousand, etc.)
  const multMatch = str.match(/^([0-9\s.,]+)\s*([kmbt]|mil|million|kilo|thousand|bil|billion)\b/i);
  if (multMatch) {
    let numPart = multMatch[1].trim().replace(/\s+/g, "");
    const unit = multMatch[2].toLowerCase();
    if (numPart.includes(",") && !numPart.includes(".")) {
      numPart = numPart.replace(",", ".");
    } else {
      numPart = numPart.replace(/,/g, "");
    }
    const base = parseFloat(numPart);
    if (Number.isFinite(base)) {
      const multiplier =
        unit.startsWith("k") || unit.startsWith("t")
          ? 1e3
          : unit.startsWith("m")
          ? 1e6
          : 1e9;
      const res = Math.round(base * multiplier);
      return isNegative ? -res : res;
    }
    return fallback;
  }

  // 9. Clean thousand separators and parse standard numbers
  str = str.replace(/\s+/g, "");
  const hasDot = str.includes(".");
  const hasComma = str.includes(",");

  if (hasDot && hasComma) {
    const lastDot = str.lastIndexOf(".");
    const lastComma = str.lastIndexOf(",");
    if (lastComma > lastDot) {
      str = str.replace(/\./g, "").replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    const lastComma = str.lastIndexOf(",");
    const digitsAfter = str.length - lastComma - 1;
    const commaCount = (str.match(/,/g) || []).length;
    if (commaCount > 1 || digitsAfter === 3) {
      str = str.replace(/,/g, "");
    } else {
      str = str.replace(",", ".");
    }
  } else if (hasDot && !hasComma) {
    const dotCount = (str.match(/\./g) || []).length;
    if (dotCount > 1) {
      str = str.replace(/\./g, "");
    }
  }

  // 10. Parse primary numeric token
  const numMatch = str.match(/^[-+]?[0-9]+(?:\.[0-9]+)?/);
  if (numMatch) {
    const num = parseFloat(numMatch[0]);
    if (Number.isFinite(num)) {
      const finalVal = roundDollarsToCents(num);
      return isNegative ? -finalVal : finalVal;
    }
  }
  return fallback;
}

export function numberToWords(num: number): string {
  num = Math.round(num);
  const units = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  if (num >= 1000000) {
    const millions = Math.floor(num / 1000000);
    const rem = num % 1000000;
    return `${numberToWords(millions)} Million` + (rem ? ` ${numberToWords(rem)}` : "");
  }
  if (num >= 1000) {
    const thousands = Math.floor(num / 1000);
    const rem = num % 1000;
    return `${numberToWords(thousands)} Thousand` + (rem ? ` ${numberToWords(rem)}` : "");
  }
  if (num >= 100) {
    const hundreds = Math.floor(num / 100);
    const rem = num % 100;
    return `${units[hundreds]} Hundred` + (rem ? ` ${numberToWords(rem)}` : "");
  }
  if (num >= 20) {
    const t = Math.floor(num / 10);
    const rem = num % 10;
    return tens[t] + (rem ? `-${units[rem]}` : "");
  }
  if (num > 0) return units[num];
  return "Zero";
}

const STATE_FULL_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  // Canadian Provinces & Territories
  ON: "Ontario", BC: "British Columbia", AB: "Alberta", QC: "Quebec",
  MB: "Manitoba", SK: "Saskatchewan", NS: "Nova Scotia", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", PE: "Prince Edward Island",
  NT: "Northwest Territories", YT: "Yukon", NU: "Nunavut",
  // International Regions
  UK: "United Kingdom", ENG: "England", SCT: "Scotland", WLS: "Wales",
  AU: "Australia", NSW: "New South Wales", VIC: "Victoria", QLD: "Queensland",
};

export function getStateAbbreviation(stateInput?: string): string {
  if (!stateInput) return "TX";
  const cleaned = stateInput
    .replace(/\b(?:USA|US|UNITED STATES|CANADA|CAN)\b/gi, "")
    .replace(/\b\d{5}(?:-\d{4})?\b/g, "")
    .replace(/\b[A-Z]\d[A-Z]\s*\d[A-Z]\d\b/gi, "")
    .replace(/[^a-zA-Z\s]/g, " ")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");

  if (!cleaned) return "TX";

  const map: Record<string, string> = {
    ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA",
    COLORADO: "CO", CONNECTICUT: "CT", DELAWARE: "DE", "DISTRICT OF COLUMBIA": "DC", FLORIDA: "FL", GEORGIA: "GA",
    HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA",
    KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD",
    MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO",
    MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ",
    "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH",
    OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC",
    "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT",
    VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV", WISCONSIN: "WI", WYOMING: "WY",
    // Canadian Provinces & Territories
    ONTARIO: "ON", "BRITISH COLUMBIA": "BC", ALBERTA: "AB", QUEBEC: "QC",
    MANITOBA: "MB", SASKATCHEWAN: "SK", "NOVA SCOTIA": "NS", "NEW BRUNSWICK": "NB",
    "NEWFOUNDLAND AND LABRADOR": "NL", NEWFOUNDLAND: "NL", "PRINCE EDWARD ISLAND": "PE",
    "NORTHWEST TERRITORIES": "NT", YUKON: "YT", NUNAVUT: "NU",
    // International Regions
    "UNITED KINGDOM": "UK", UK: "UK", ENGLAND: "ENG", SCOTLAND: "SCT", WALES: "WLS",
    AUSTRALIA: "AU", "NEW SOUTH WALES": "NSW", VICTORIA: "VIC", QUEENSLAND: "QLD",
  };

  const validCodes = new Set(Object.values(map));
  if ((cleaned.length === 2 || cleaned.length === 3) && validCodes.has(cleaned)) {
    return cleaned;
  }

  if (map[cleaned]) return map[cleaned];

  const tokens = cleaned.split(" ");
  for (const t of tokens) {
    if ((t.length === 2 || t.length === 3) && validCodes.has(t)) {
      return t;
    }
  }

  for (const [name, abbr] of Object.entries(map)) {
    if (cleaned.startsWith(name) || cleaned.includes(name)) {
      return abbr;
    }
  }

  return (cleaned.length === 2 || cleaned.length === 3) ? cleaned : (map[cleaned] || "TX");
}

export function parseCityAndState(location?: string): { city: string; state: string; stateAbbr: string } {
  if (!location || !location.trim()) {
    return { city: "Austin", state: "Texas", stateAbbr: "TX" };
  }

  const trimmed = location.trim();

  // If comma separated, e.g. "Austin, Texas", "Seattle, WA 98101", "Toronto, ON, Canada"
  if (trimmed.includes(",")) {
    const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    const city = parts[0] || "Austin";
    const statePart = parts[1] || "";
    const stateAbbr = getStateAbbreviation(statePart);
    const state = STATE_FULL_NAMES[stateAbbr] || statePart || "Texas";
    return { city, state, stateAbbr };
  }

  // No comma, e.g. "Denver CO", "Denver CO 80202", "Vancouver BC", "Austin Texas"
  const tokens = trimmed.split(/\s+/);
  let foundStateAbbr: string | null = null;
  let splitIndex = tokens.length;

  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i].toUpperCase().replace(/[^A-Z]/g, "");
    if ((token.length === 2 || token.length === 3) && STATE_FULL_NAMES[token]) {
      foundStateAbbr = token;
      splitIndex = i;
      break;
    }
  }

  if (!foundStateAbbr) {
    const abbr = getStateAbbreviation(trimmed);
    if (abbr && abbr !== "TX") {
      foundStateAbbr = abbr;
      for (let i = 0; i < tokens.length; i++) {
        if (getStateAbbreviation(tokens.slice(i).join(" ")) === abbr) {
          splitIndex = i;
          break;
        }
      }
    }
  }

  const stateAbbr = foundStateAbbr || "TX";
  const state = STATE_FULL_NAMES[stateAbbr] || "Texas";
  const city = tokens.slice(0, Math.max(1, splitIndex)).join(" ").trim() || "Austin";

  return { city, state, stateAbbr };
}

