/**
 * Jobright.ai — same search API the site's /jobs/search page uses for
 * logged-out visitors (swan-api visitor-search). Remote = workModel 2,
 * daysAgo 1 | 3. Empty title (API requires one) or API failure falls back
 * to scraping /remote-jobs in a real tab.
 */

import {
  resolveDatePreset,
  filterByRequest,
  normalizeJob,
  sleep,
} from "./util.js";

function jobrightYears(jr) {
  const n = jr?.minYearsOfExperience;
  if (typeof n === "number" && Number.isFinite(n)) return n;
  return undefined;
}

function jobrightDescription(jr) {
  const requirements = Array.isArray(jr?.requirements)
    ? jr.requirements.filter(Boolean).join("\n")
    : "";
  return [jr?.jobSummary || "", requirements].filter(Boolean).join("\n");
}

const BASE = "https://jobright.ai";
const API = "https://swan-api.jobright.ai/swan/recommend/visitor-search";
const PAGE_SIZE = 20;
const MAX_POSITION = 1000;
const REMOTE_WORK_MODEL = 2;

/** Search URL in the site's own format, with remote + posted-date filters. */
export function jobrightSearchUrl(title, daysAgo = 1) {
  const params = new URLSearchParams({
    searchType: "job_title",
    value: title,
    country: "US",
    workModel: String(REMOTE_WORK_MODEL),
    daysAgo: String(daysAgo),
  });
  return `${BASE}/jobs/search?${params}`;
}

function toDatePosted(publishTime) {
  if (!publishTime) return "";
  // "2026-09-29 01:43:46" (UTC)
  const t = Date.parse(String(publishTime).replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return String(publishTime).slice(0, 10);
  return new Date(t).toISOString();
}

function normalizeItem(item) {
  const jr = item?.jobResult || {};
  const cr = item?.companyResult || {};
  if (!jr.jobId && !jr.jobTitle) return null;
  const isRemote =
    jr.isRemote === true || /remote/i.test(String(jr.workModel || ""));
  const locs = Array.isArray(jr.jobLocations)
    ? jr.jobLocations.join(", ")
    : jr.jobLocation || "";
  return normalizeJob({
    title: jr.jobTitle || "",
    company: cr.companyName || "",
    location: locs || "Remote",
    site: "jobright",
    listing_type: jr.employmentType || "",
    date_posted: toDatePosted(jr.publishTime),
    is_remote: isRemote,
    job_url: jr.jobId ? `${BASE}/jobs/info/${jr.jobId}` : jr.url || "",
    job_url_direct: "",
    description: jobrightDescription(jr),
    years_required: jobrightYears(jr),
  });
}

function jobrightJobTypes(jobType) {
  if (jobType === "fulltime") return [1];
  if (jobType === "contract") return [2];
  return [];
}

async function searchPage(title, daysAgo, position, jobType) {
  const qs = new URLSearchParams({
    lite: "false",
    count: String(PAGE_SIZE),
    position: String(position),
    searchType: "job_title",
  });
  const res = await fetch(`${API}?${qs}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jobTaxonomyList: [{ taxonomyId: "00-00-00", title }],
      value: title,
      searchType: "job_title",
      country: "US",
      workModel: [REMOTE_WORK_MODEL],
      daysAgo,
      locations: [],
      jobTypes: jobrightJobTypes(jobType),
      seniority: [],
      companies: [],
      count: PAGE_SIZE,
      position,
      refresh: position === 0,
    }),
  });
  if (!res.ok) throw new Error(`Jobright API HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.success) {
    throw new Error(`Jobright API: ${data?.errorMsg || "unsuccessful response"}`);
  }
  return data.result || {};
}

async function scrapeViaApi({
  query,
  title,
  resultsWanted,
  preset,
  years,
  jobType,
  onProgress,
}) {
  const daysAgo = preset.jobrightDaysAgo || 1;
  const matched = [];
  const seen = new Set();
  let scanned = 0;
  let total = null;

  for (let position = 0; position < MAX_POSITION; position += PAGE_SIZE) {
    onProgress?.(
      `Jobright page ${position / PAGE_SIZE + 1} (${matched.length}/${resultsWanted} matching)…`
    );
    const result = await searchPage(query, daysAgo, position, jobType);
    if (result.jobNum != null) total = Number(result.jobNum);
    const list = Array.isArray(result.jobList) ? result.jobList : [];
    if (!list.length) break;

    const page = [];
    for (const item of list) {
      const job = normalizeItem(item);
      if (!job || seen.has(job.job_url)) continue;
      seen.add(job.job_url);
      if (job.is_remote === "Yes") page.push(job);
    }
    scanned += list.length;
    matched.push(
      ...filterByRequest(page, {
        hoursOld: preset.hoursOld,
        title,
        years,
        jobType,
      })
    );
    if (matched.length >= resultsWanted) break;
    if (total != null && position + PAGE_SIZE >= total) break;
    await sleep(300);
  }

  onProgress?.(
    `Jobright: ${scanned} scanned (site total ${total ?? "?"}) → ${matched.length} matching title`
  );
  return matched
    .slice(0, resultsWanted)
    .map((j) => ({ ...j, date_posted: j.date_posted.slice(0, 10) }));
}

async function scrapeViaTab({
  searchTerm,
  title,
  resultsWanted,
  preset,
  years,
  jobType,
  onProgress,
}) {
  onProgress?.("Jobright: opening site tab…");
  const response = await chrome.runtime.sendMessage({
    type: "JOBRIGHT_SCRAPE",
    payload: {
      searchTerm: (title || searchTerm || "").trim(),
      resultsWanted: Math.min(200, resultsWanted * 3),
      hoursOld: preset.hoursOld,
      daysAgo: preset.jobrightDaysAgo || 1,
      years: years ?? "",
      jobType: jobType || "",
    },
  });
  if (!response) {
    throw new Error("Jobright: no response from extension background");
  }
  if (response.error && !(response.jobs && response.jobs.length)) {
    throw new Error(response.error);
  }
  let jobs = response.jobs || [];
  jobs = filterByRequest(jobs, {
    hoursOld: preset.hoursOld,
    title: title || "",
    years,
    jobType,
  });
  onProgress?.(
    `Jobright (tab): ${response.rawCount ?? jobs.length} raw → ${jobs.length} matching title`
  );
  return jobs.slice(0, resultsWanted);
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
export async function scrapeJobright({
  searchTerm,
  title,
  resultsWanted,
  datePreset,
  years,
  jobType,
  onProgress,
}) {
  const preset = resolveDatePreset(datePreset);
  const query = (title || searchTerm || "").trim();
  const opts = {
    searchTerm,
    title: (title || "").trim(),
    resultsWanted,
    preset,
    years,
    jobType,
    onProgress,
  };

  if (!query) return scrapeViaTab(opts);

  try {
    return await scrapeViaApi({ ...opts, query });
  } catch (err) {
    onProgress?.(
      `Jobright API failed (${err?.message || err}); trying site tab…`
    );
    return scrapeViaTab(opts);
  }
}
