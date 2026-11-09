// Image URLs pushed by the local Trade Me app (Trade Me's PictureHref) are
// untrusted input. They are never fetched by this server; the packer's
// browser loads them directly as <img> thumbnails. Before storing one we
// accept only:
//   - http(s) URLs (http is upgraded to https so the embedded app never
//     loads mixed content);
//   - on a Trade Me photo host (trademe.co.nz or tmcdn.co.nz, or a
//     subdomain of either);
//   - with no username/password and no non-standard port;
//   - at most 2048 characters.
// Anything else (empty, malformed, javascript:/data: URLs, other hosts)
// becomes null, and Pack Check shows its usual SKU placeholder.

const ALLOWED_HOST_SUFFIXES = ["trademe.co.nz", "tmcdn.co.nz"];
const MAX_LENGTH = 2048;

export function sanitiseTradeMeImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_LENGTH) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return null;

  url.protocol = "https:";
  return url.toString();
}
