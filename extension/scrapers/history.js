/**
 * Jobs already downloaded, remembered in this browser (chrome.storage.local)
 * so later runs can skip them. A job is known by its link and by its title +
 * company, so the same job found on another board later is a repeat too.
 * Entries are kept for 30 days; the date windows are at most 3 days.
 */

const STORE_KEY = "downloadedJobs";
const KEEP_MS = 30 * 86400e3;
// Tracking parameters that change between visits to the same job
const TRACKING_PARAM_RE = /^(?:utm_\w+|trk|trackingId|refId|ref|src|source|from|gh_src|lever-source)$/i;

/** Lowercase words only: the same rule the run uses to merge boards. */
export const normalizeWords = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();

function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const name of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM_RE.test(name)) u.searchParams.delete(name);
    }
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return String(url || "").trim();
  }
}

/** The keys a job is remembered by. Turing lists every role as "Turing", so only its link counts. */
export function jobKeys(job) {
  const keys = [];
  if (job?.job_url) keys.push(`url:${canonicalUrl(job.job_url)}`);
  const title = normalizeWords(job?.title);
  const company = normalizeWords(job?.company);
  if (title && company && job.site !== "turing") keys.push(`job:${title}|${company}`);
  return keys;
}

async function readEntries(now) {
  const { [STORE_KEY]: entries } = await chrome.storage.local.get(STORE_KEY);
  return (Array.isArray(entries) ? entries : []).filter((e) => now - e.at < KEEP_MS);
}

/**
 * What earlier runs downloaded:
 *   has(job)                 — the job was downloaded before
 *   recentCount(site, hours) — jobs from that board downloaded within the last
 *                              `hours` (+ a day), which may come back in this run's window
 */
export async function loadDownloaded(now = Date.now()) {
  const entries = await readEntries(now);
  const keys = new Set(entries.flatMap((e) => e.keys));
  return {
    size: entries.length,
    has: (job) => jobKeys(job).some((k) => keys.has(k)),
    recentCount: (site, hours) =>
      entries.filter((e) => e.site === site && now - e.at <= (hours + 24) * 3600e3).length,
  };
}

/** Remember these jobs as downloaded now (a job downloaded again is refreshed, not added twice). */
export async function rememberDownloaded(jobs, now = Date.now()) {
  const fresh = jobs.map((job) => ({ keys: jobKeys(job), site: job.site, at: now }));
  const freshKeys = new Set(fresh.flatMap((e) => e.keys));
  const kept = (await readEntries(now)).filter((e) => !e.keys.some((k) => freshKeys.has(k)));
  await chrome.storage.local.set({ [STORE_KEY]: [...kept, ...fresh] });
}

export async function forgetDownloaded() {
  await chrome.storage.local.remove(STORE_KEY);
}

export async function downloadedCount(now = Date.now()) {
  return (await readEntries(now)).length;
}
