// Redaction for the read-only order diagnostic. The goal is to show where a
// Trade Me channel stores its purchase/listing references, without exposing
// customer details. Customer, address and contact fields are never queried
// at all; this module cleans the free-text fields that are (note, tags,
// custom attributes, metafields), which can contain personal details too.
//
// Kept:     long numeric IDs (purchase/listing IDs), SKUs, GIDs, keys.
// Redacted: email addresses, NZ/international phone numbers, and the whole
//           value of any field whose key looks personal (name, email, phone,
//           address, ...).

const PERSONAL_KEY = /(^|[_\s.-])(name|first|last|email|e-mail|phone|mobile|tel|address|street|suburb|city|post(al)?code|zip|buyer|customer|recipient|contact)([_\s.-]|$)/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Phone numbers: "+64 21 123 4567", "021 123 4567", "(09) 123-4567". A
// leading + or 0 is required, so bare Trade Me IDs ("4567890123") survive.
const PHONE = /\+\d{1,3}[\s-]?\d{1,4}[\s-]?\d{3}[\s-]?\d{3,4}\b|\(0\d{1,2}\)[\s-]?\d{3}[\s-]?\d{3,4}\b|\b0\d{1,2}[\s-]?\d{3}[\s-]?\d{3,4}\b/g;

export function redactText(value: string): string {
  return value.replace(EMAIL, "[email]").replace(PHONE, "[phone]");
}

export function redactPair(key: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (PERSONAL_KEY.test(key)) return `[redacted: ${text.length} chars]`;
  return redactText(text);
}
