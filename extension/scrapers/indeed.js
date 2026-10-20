/**
 * Indeed scraper — remote attribute filter (DSQF7) + title query.
 * Date is applied client-side (Indeed cannot combine date + remote filters).
 */

import {
  normalizeJob,
  formatLocation,
  stripHtml,
  resolveDatePreset,
  filterByRequest,
  employmentKinds,
  yearsFromExperienceLabels,
  requiredYearsFromText,
  withinHours,
} from "./util.js";
import { readJson } from "./http.js";

const API_URL = "https://apis.indeed.com/graphql";
const BASE_URL = "https://www.indeed.com";

const HEADERS = {
  "content-type": "application/json",
  "indeed-api-key":
    "161092c2017b5bbab13edb12461a62d5a833871e7cad6d9d475304573de67ac8",
  accept: "application/json",
  "indeed-locale": "en-US",
  "accept-language": "en-US,en;q=0.9",
  "indeed-co": "US",
  "indeed-app-info":
    "appv=193.1; appid=com.indeed.jobsearch; osv=16.6.1; os=ios; dtype=phone",
};

const QUERY_TMPL = `
query GetJobData {
  jobSearch(
    {{WHAT}}
    {{LOCATION}}
    limit: 100
    {{CURSOR}}
    sort: DATE
    filters: {
      composite: {
        filters: [{
          keyword: {
            field: "attributes"
            keys: [{{TYPE_KEYS}}]
          }
        }]
      }
    }
  ) {
    pageInfo { nextCursor }
    results {
      job {
        key
        title
        datePublished
        description { html }
        location {
          city
          admin1Code
          countryCode
          formatted { long }
        }
        employer { name }
        attributes { key label }
        recruit { viewJobUrl }
      }
    }
  }
}
`;

function indeedJobTypeKey(jobType) {
  if (jobType === "contract") return "NJXCK";
  if (jobType === "fulltime") return "CF3CP";
  return "";
}

function buildQuery(whatTerm, cursor, jobType) {
  // Indeed needs every word (title + stack). JSON string escaping is valid
  // GraphQL string escaping, so quotes and backslashes in the input are safe.
  const term = (whatTerm || "").trim();
  const what = term ? `what: ${JSON.stringify(term)}` : "";
  const location = `location: { where: "United States", radius: 100, radiusUnit: MILES }`;
  const cursorPart = cursor ? `cursor: "${cursor}"` : "";
  const typeKeys = ["DSQF7", indeedJobTypeKey(jobType)]
    .filter(Boolean)
    .map((key) => `"${key}"`)
    .join(", ");
  return QUERY_TMPL.replace("{{WHAT}}", what)
    .replace("{{LOCATION}}", location)
    .replace("{{CURSOR}}", cursorPart)
    .replace("{{TYPE_KEYS}}", typeKeys);
}

function toDatePosted(ms) {
  if (!ms) return "";
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return "";
  }
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
export async function scrapeIndeed({
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
  const whatTerm = (searchTerm || "").trim();
  const titleFilter = (title || "").trim();
  const matched = [];
  const seen = new Set();
  let scanned = 0;
  let cursor = null;
  let page = 0;
  // `what` also matches descriptions: title hits are spread across ~1000 results
  const MAX_PAGES = 10;

  while (matched.length < resultsWanted && page < MAX_PAGES) {
    page += 1;
    onProgress?.(
      `Indeed page ${page} (${preset.label}, ${matched.length}/${resultsWanted} matching)…`
    );
    const query = buildQuery(whatTerm, cursor, jobType);
    const res = await fetch(API_URL, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ query }),
    });
    const data = await readJson(res, "indeed", "Indeed");
    if (!res.ok) {
      throw new Error(`Indeed HTTP ${res.status}: ${data?.errors?.[0]?.message || "request rejected"}`);
    }
    const search = data?.data?.jobSearch;
    if (!search) {
      const err = data?.errors?.[0]?.message;
      throw new Error(err || "Indeed returned no jobSearch data");
    }
    const results = search.results || [];
    if (!results.length) break;

    const pageJobs = [];
    for (const row of results) {
      const job = row.job;
      if (!job?.key) continue;
      const jobUrl = `${BASE_URL}/viewjob?jk=${job.key}`;
      if (seen.has(jobUrl)) continue;
      seen.add(jobUrl);
      scanned += 1;
      const loc = job.location || {};
      const labels = (job.attributes || [])
        .map((attr) => attr?.label)
        .filter(Boolean);
      const listingType = labels
        .filter((label) => employmentKinds(label).length)
        .join(", ");
      const description = stripHtml(job.description?.html);
      const fromLabels = yearsFromExperienceLabels(labels);
      const fromText = requiredYearsFromText(description);
      const yearsRequired =
        fromLabels == null
          ? fromText
          : fromText == null
            ? fromLabels
            : Math.max(fromLabels, fromText);
      pageJobs.push(
        normalizeJob({
          title: job.title,
          company: job.employer?.name || "",
          location:
            loc.formatted?.long ||
            formatLocation([loc.city, loc.admin1Code, loc.countryCode]),
          site: "indeed",
          listing_type: listingType,
          date_posted: toDatePosted(job.datePublished),
          is_remote: true,
          job_url: jobUrl,
          job_url_direct: job.recruit?.viewJobUrl || "",
          description,
          years_required: yearsRequired == null ? undefined : yearsRequired,
        })
      );
    }
    matched.push(
      ...filterByRequest(pageJobs, {
        hoursOld: preset.hoursOld,
        title: titleFilter,
        stack,
        years,
        jobType,
      })
    );

    // Results are newest first: once a whole page is too old, the rest are too
    const dated = pageJobs.filter((j) => j.date_posted);
    if (dated.length && dated.every((j) => !withinHours(j.date_posted, preset.hoursOld))) {
      break;
    }

    cursor = search.pageInfo?.nextCursor || null;
    if (!cursor) break;
  }

  onProgress?.(`Indeed: ${scanned} scanned → ${matched.length} matching title`);
  return matched.slice(0, resultsWanted);
}
