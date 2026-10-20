/**
 * Jobicy — free public JSON API (no key), remote-only board.
 * https://github.com/Jobicy/remote-jobs-api
 *   GET /api/jobs?count=1-200&geo=<slug>&tag=<3-50 bytes>&cursor=<nextCursor>
 *   (/api/v2/remote-jobs is the older path with the same params.)
 * Unknown parameters are rejected with 400, so only documented ones are sent.
 * Newest first; the feed covers about the last 7 days, and listings show up a
 * few hours after their pubDate. Jobicy also re-publishes older listings with
 * a fresh pubDate. Volume is small, so the newest pages are filtered here:
 * the `tag` search is a raw substring match ("rust" finds "trust") that knows
 * none of the title matcher's synonyms (Sr = Senior, k8s = Kubernetes).
 * Terms: credit Jobicy and link to the Jobicy job URL (kept as job_url); no
 * automated polling more than once an hour.
 */

import {
  normalizeJob,
  resolveDatePreset,
  filterByRequest,
  stripHtml,
  withinHours,
} from "./util.js";
import { readJson } from "./http.js";

const BASE = "https://jobicy.com";
const PATHS = ["/api/jobs", "/api/v2/remote-jobs"];
// geo=usa may leave out "Anywhere" jobs, so ask for both and merge
const GEOS = ["usa", "anywhere"];
const MAX_PAGES_PER_GEO = 5;
const US_GEO_RE = /\b(?:usa|united states|us|anywhere|worldwide|north america|americas)\b/i;

async function getPage(params) {
  let lastStatus = 0;
  for (const path of PATHS) {
    const res = await fetch(`${BASE}${path}?${params}`, {
      headers: { accept: "application/json" },
    });
    lastStatus = res.status;
    if (res.status === 404) continue;
    const data = await readJson(res, "jobicy", "Jobicy");
    if (!res.ok || data?.success === false) {
      throw new Error(`Jobicy: ${data?.error || data?.message || `HTTP ${res.status}`}`);
    }
    return data;
  }
  throw new Error(`Jobicy HTTP ${lastStatus}`);
}

function toJob(row) {
  const geo = String(row.jobGeo || "").replace(/,\s+/g, ", ").trim();
  return {
    ...normalizeJob({
      title: String(row.jobTitle || "").trim(),
      company: String(row.companyName || "").trim(),
      location: geo ? `Remote (${geo})` : "Remote",
      site: "jobicy",
      listing_type: Array.isArray(row.jobType) ? row.jobType.join(", ") : String(row.jobType || ""),
      // Full timestamp while filtering; trimmed to the day for the sheet
      date_posted: row.pubDate || "",
      is_remote: true,
      easy_apply: false,
      job_url: row.url || (row.jobSlug ? `${BASE}/jobs/${row.jobSlug}` : ""),
      description: stripHtml(row.jobDescription || row.jobExcerpt || ""),
    }),
    _id: String(row.id ?? row.url ?? ""),
    _geo: geo,
  };
}

/**
 * @param {{
 *   searchTerm: string,
 *   title?: string,
 *   stack?: string,
 *   resultsWanted: number,
 *   datePreset?: string,
 *   years?: number | "",
 *   jobType?: string,
 *   onProgress?: (msg: string) => void
 * }} opts
 */
export async function scrapeJobicy({
  title,
  stack,
  resultsWanted,
  datePreset,
  years,
  jobType,
  onProgress,
}) {
  const preset = resolveDatePreset(datePreset);
  const titleFilter = (title || "").trim();
  const count = 200;
  const matched = [];
  const seen = new Set();
  let scanned = 0;
  let stoppedEarly = "";

  for (const geo of GEOS) {
    let cursor = "";
    for (let page = 1; page <= MAX_PAGES_PER_GEO && matched.length < resultsWanted; page++) {
      onProgress?.(`Jobicy ${geo} page ${page} (${matched.length}/${resultsWanted} matching)…`);
      const params = new URLSearchParams({ count: String(count), geo });
      if (cursor) params.set("cursor", cursor);
      let data;
      try {
        data = await getPage(params);
      } catch (err) {
        // Keep what earlier pages found; with nothing found, the board failed
        if (!matched.length) throw err;
        stoppedEarly = err?.message || String(err);
        break;
      }
      const rows = Array.isArray(data.jobs) ? data.jobs : [];
      const fresh = [];
      for (const row of rows) {
        const job = toJob(row);
        if (seen.has(job._id)) continue;
        seen.add(job._id);
        scanned += 1;
        if (job._geo && !job._geo.split(/,\s*/).some((g) => US_GEO_RE.test(g))) continue;
        fresh.push(job);
      }
      matched.push(
        ...filterByRequest(fresh, {
          hoursOld: preset.hoursOld,
          title: titleFilter,
          stack,
          years,
          jobType,
        })
      );
      // Newest first: once the last row is too old, the rest are too
      const last = rows[rows.length - 1];
      if (!rows.length || !data.nextCursor || (last && !withinHours(last.pubDate, preset.hoursOld))) {
        break;
      }
      cursor = data.nextCursor;
    }
    if (stoppedEarly || matched.length >= resultsWanted) break;
  }

  onProgress?.(`Jobicy: ${scanned} scanned → ${matched.length} matching`);
  if (stoppedEarly) {
    onProgress?.(`Jobicy stopped early, results may be incomplete: ${stoppedEarly}`);
  }
  return matched.slice(0, resultsWanted).map(({ _id, _geo, ...job }) => ({
    ...job,
    date_posted: String(job.date_posted).slice(0, 10),
  }));
}
