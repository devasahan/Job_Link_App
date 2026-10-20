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
