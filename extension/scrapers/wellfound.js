/**
 * Wellfound via orgupdate API — same contract as JobSpy / Apify scraper.
 */

import {
  normalizeJob,
  resolveDatePreset,
  filterByRequest,
} from "./util.js";
import { blockedError, isBlockedResponse } from "./http.js";

const API_URL = "https://api.orgupdate.com/search-jobs-v1";
const PER_PAGE = 20;

const URL_KEYS = [
  "applyUrl",
  "apply_url",
  "applicationUrl",
  "jobUrlDirect",
  "job_url_direct",
  "jobUrl",
  "job_url",
  "URL",
  "url",
  "link",
];

function pick(row, ...keys) {
  for (const k of keys) {
    const v = row[k];
    if (v != null && v !== "") return v;
  }
  return null;
}

function bestUrl(row) {
  for (const k of URL_KEYS) {
    const v = row[k];
    if (typeof v === "string" && v.startsWith("http")) return v.trim();
  }
  return "";
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload.filter((x) => x && typeof x === "object");
  if (payload && typeof payload === "object") {
    for (const key of ["jobs", "data", "results", "items", "list"]) {
      if (Array.isArray(payload[key])) {
        return payload[key].filter((x) => x && typeof x === "object");
      }
    }
  }
  return [];
}

function normalizePostedDate(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return s.slice(0, 10);
}

/**
 * @param {{
 *   searchTerm: string,
 *   title?: string,
 *   resultsWanted: number,
 *   datePreset?: string,
 *   years?: number | "",
 *   jobType?: string,
 *   onProgress?: (msg: string) => void
 * }} opts
 */
export async function scrapeWellfound({
  searchTerm,
  title,
  resultsWanted,
  datePreset,
  years,
  jobType,
  onProgress,
}) {
  const preset = resolveDatePreset(datePreset);
  const titleFilter = (title || "").trim();
  // Fetch extra pages so title filter still fills the quota
  const pages = Math.max(
    1,
    Math.ceil(Math.max(resultsWanted * 3, 40) / PER_PAGE)
  );
  let keyword = (title || searchTerm || "").trim();
  if (keyword) keyword = `${keyword} remote`;
  else keyword = "remote";

  onProgress?.(`Wellfound (${pages} page(s), ${preset.label})…`);

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      source: "wellfound",
      countryName: "usa",
      includeKeyword: keyword,
      locationName: "",
      pagesToFetch: pages,
      datePosted: preset.wellfound,
      ...(jobType === "contract"
        ? { jobType: "CONTRACTOR" }
        : jobType === "fulltime"
          ? { jobType: "FULLTIME" }
          : {}),
    }),
  });

  const raw = await res.text();
  if (!res.ok || isBlockedResponse(res.status, raw)) {
    throw blockedError("wellfound", res.status, raw);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("Wellfound returned non-JSON (blocked or unexpected response)");
  }
  const rows = extractRows(payload);
  const jobs = [];
  const seen = new Set();

  for (const row of rows) {
    const url = bestUrl(row);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const jobTitle =
      pick(row, "job_title", "jobTitle", "title") || "Untitled";
    const company =
      pick(row, "company_name", "companyName", "company") || "";
    const location = pick(row, "location", "jobLocation") || "";
    const description =
      pick(row, "description", "jobDescription") || "";
    const listing =
      pick(row, "job_type", "jobType", "employmentType", "employment_type") ||
      "";
    const postedRaw = pick(row, "date", "postedDate", "posted_date");

    jobs.push(
      normalizeJob({
        title: String(jobTitle).trim(),
        company: String(company).trim(),
        location: String(location).trim(),
        site: "wellfound",
        listing_type: String(listing),
        date_posted: normalizePostedDate(postedRaw),
        is_remote: true,
        job_url: url,
        description: String(description).trim(),
      })
    );
  }

  const filtered = filterByRequest(jobs, {
    hoursOld: preset.hoursOld,
    title: titleFilter,
    years,
    jobType,
  });
  onProgress?.(
    `Wellfound: ${jobs.length} raw → ${filtered.length} matching title`
  );
  return filtered.slice(0, resultsWanted);
}
