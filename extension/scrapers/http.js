/** Shared HTTP helpers for scrapers. */

export function isBlockedResponse(status, bodyText = "") {
  if (status === 403 || status === 429 || status === 503) return true;
  const t = String(bodyText || "").slice(0, 800).toLowerCase();
  return (
    t.includes("security | glassdoor") ||
    t.includes("cf-browser-verification") ||
    t.includes("attention required") ||
    t.includes("access denied")
  );
}

export function blockedError(site, status, bodyText = "") {
  const snip = String(bodyText || "").replace(/\s+/g, " ").slice(0, 120);
  if (site === "glassdoor") {
    return new Error(
      `Glassdoor HTTP ${status} (blocked). Open https://www.glassdoor.com in a normal tab, pass any security check, then retry.`
    );
  }
  if (site === "indeed") {
    return new Error(
      `Indeed HTTP ${status}. Reload the extension so header rules install (Indeed requires a special User-Agent).`
    );
  }
  return new Error(
    `${site} HTTP ${status}${snip ? `: ${snip}` : ""}`
  );
}

/**
 * Parse a JSON API response. A block page is only suspected when the body
 * isn't JSON: job text inside real JSON can say "access denied".
 */
export async function readJson(res, site, label = site) {
  const raw = (await res.text()).replace(/[\u0000-\u001f]/g, (c) => (/[\n\r\t]/.test(c) ? " " : ""));
  if (res.status === 403 || res.status === 429 || res.status === 503) {
    throw blockedError(site, res.status, raw);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    if (isBlockedResponse(res.status, raw)) throw blockedError(site, res.status, raw);
    throw new Error(`${label} returned non-JSON (HTTP ${res.status})`);
  }
  return data;
}
