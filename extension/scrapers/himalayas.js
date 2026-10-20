/**
 * Himalayas — free public JSON API (no key), remote-only board.
 * https://github.com/Himalayas-App/remote-jobs-api
 *   GET /jobs/api/search?q=&country=US&sort=recent&employment_type=&page=N
 * 20 jobs a page (often a few fewer after de-duplication), newest first with
 * sort=recent. country=US also returns worldwide jobs. `q` is a fuzzy
 * full-text search, so titles are filtered here. The API sends no CORS
 * headers; the extension's host permission covers that. Himalayas is reported to
 * refuse browser-like user agents on this API, so a header rule sends a plain
 * client name for the extension's own requests. Responses are cached by
 * Himalayas for up to a day. Position 1 of a page can be a promoted listing,
 * so page dates are judged on every job, not the first.
 * Terms: credit Himalayas and link to the job on himalayas.app (kept as job_url).
 */

import {
  normalizeJob,
  resolveDatePreset,
  filterByRequest,
  sleep,
  stripHtml,
  withinHours,
} from "./util.js";
import { readJson } from "./http.js";

const BASE = "https://himalayas.app";
const PER_PAGE = 20;
// About 8-9 pages a day for a broad title
const MAX_PAGES_24H = 10;
const MAX_PAGES_72H = 20;

function employmentType(jobType) {
  if (jobType === "fulltime") return "Full Time";
  if (jobType === "contract") return "Contractor";
  return "";
}

// ["United States"], or {alpha2: "US", name: "United States"} per the spec
function countryNames(list) {
  return (Array.isArray(list) ? list : [])
    .map((c) => (typeof c === "string" ? c : c?.name || c?.alpha2 || ""))
    .filter(Boolean);
}
const isUs = (name) => /^(?:us|usa|united states)$/i.test(String(name).trim());

/** Seconds in real responses, milliseconds in the spec. */
function toIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n > 1e12 ? n : n * 1000).toISOString();
}

function toJob(row) {
  const countries = countryNames(row.locationRestrictions);
  // Lists can hold 70+ countries: keep the cell short
  const others = countries.filter((c) => !isUs(c)).length;
  const company =
    row.companyName && row.companyName !== "name" ? row.companyName : row.companySlug || "";
  let direct = "";
  try {
    if (row.applicationLink && new URL(row.applicationLink).hostname !== "himalayas.app") {
      direct = row.applicationLink;
    }
  } catch {
    direct = "";
  }
  // Categories are skill-like ("React-Native-Developer"): let the stack see them
  const categories = Array.isArray(row.categories) ? row.categories.join(" ").replace(/-/g, " ") : "";
  return {
    ...normalizeJob({
      title: String(row.title || "").trim(),
      company: String(company).trim(),
      location: !countries.length
        ? "Remote (Worldwide)"
        : `Remote (US${others ? ` + ${others} ${others === 1 ? "country" : "countries"}` : ""})`,
      site: "himalayas",
      listing_type: row.employmentType || "",
      date_posted: toIso(row.pubDate),
      is_remote: true,
      easy_apply: false,
      job_url: row.guid || row.applicationLink || "",
      job_url_direct: direct,
      description: `${stripHtml(row.description || row.excerpt || "").replace(
        /\s*Originally posted on Himalayas\.?\s*$/i,
        ""
      )} ${categories}`.trim(),
    }),
    _id: String(row.guid || row.applicationLink || `${row.title}|${company}`),
    _countries: countries,
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
export async function scrapeHimalayas({
  searchTerm,
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
  // Search the title only: extra words make the fuzzy search broader, not narrower
  const q = titleFilter || (searchTerm || "").trim();
  const type = employmentType(jobType);
  const matched = [];
  const seen = new Set();
  let scanned = 0;
  let stoppedEarly = "";

  const maxPages = preset.hoursOld > 24 ? MAX_PAGES_72H : MAX_PAGES_24H;
  for (let page = 1; page <= maxPages && matched.length < resultsWanted; page++) {
    onProgress?.(`Himalayas page ${page} (${preset.label}, ${matched.length}/${resultsWanted} matching)…`);
    const params = new URLSearchParams({ country: "US", sort: "recent", page: String(page) });
    if (q) params.set("q", q);
    if (type) params.set("employment_type", type);
    const res = await fetch(`${BASE}/jobs/api/search?${params}`, {
      headers: { accept: "application/json" },
    });
    let data;
    try {
      // readJson also drops raw control characters some responses carry
      data = await readJson(res, "himalayas", "Himalayas");
      if (!res.ok) throw new Error(`Himalayas: ${data?.errors || data?.error || `HTTP ${res.status}`}`);
    } catch (err) {
      // Keep what earlier pages found; with nothing found, the board failed
      if (!matched.length) throw err;
      stoppedEarly = err?.message || String(err);
      break;
    }
    const rows = Array.isArray(data.jobs) ? data.jobs : [];
    if (!rows.length) break;

    const fresh = [];
    for (const row of rows) {
      const job = toJob(row);
      if (seen.has(job._id)) continue;
      seen.add(job._id);
      scanned += 1;
      // Empty means open worldwide
      if (job._countries.length && !job._countries.some(isUs)) continue;
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

    // Newest first, but the tail of a result set isn't: stop only when a whole page is old
    const dated = rows.map((r) => toIso(r.pubDate)).filter(Boolean);
    if (dated.length && dated.every((d) => !withinHours(d, preset.hoursOld))) break;
    const total = Number(data.totalCount);
    if (Number.isFinite(total) && page * PER_PAGE >= total) break;
    // Strictly one request at a time: parallel requests draw 429s
    await sleep(800);
  }

  onProgress?.(`Himalayas: ${scanned} scanned → ${matched.length} matching`);
  if (stoppedEarly) {
    onProgress?.(`Himalayas stopped early, results may be incomplete: ${stoppedEarly}`);
  }
  return matched.slice(0, resultsWanted).map(({ _id, _countries, ...job }) => ({
    ...job,
    date_posted: String(job.date_posted).slice(0, 10),
  }));
}
