/**
 * LinkedIn guest job search — card list only (no detail fetches).
 * Remote US only (f_WT=2 + geoId). Title tokens enforced client-side.
 */

import {
  normalizeJob,
  sleep,
  resolveDatePreset,
  filterByRequest,
} from "./util.js";

const BASE = "https://www.linkedin.com";
const SEARCH_URL = `${BASE}/jobs-guest/jobs/api/seeMoreJobPostings/search`;
const US_GEO_ID = "103644278";

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
export async function scrapeLinkedIn({
  searchTerm,
  title,
  resultsWanted,
  datePreset,
  years,
  jobType,
  onProgress,
}) {
  const preset = resolveDatePreset(datePreset);
  const secondsOld = preset.hoursOld * 3600;
  const keywords = (title || searchTerm || "").trim();
  const titleFilter = (title || "").trim();
  const listingType =
    jobType === "contract" ? "Contract" : jobType === "fulltime" ? "Full-time" : "";
  const jobs = [];
  const seen = new Set();
  let start = 0;
  let page = 0;
  const matchedCount = () =>
    filterByRequest(jobs, {
      hoursOld: preset.hoursOld,
      title: titleFilter,
      years,
      jobType,
    }).length;

  // Guest search tops out at 1000 results
  while (matchedCount() < resultsWanted && start < 1000) {
    page += 1;
    onProgress?.(
      `LinkedIn page ${page} (${preset.label}, ${matchedCount()}/${resultsWanted} matching)…`
    );

    const params = new URLSearchParams({
      keywords,
      location: "United States",
      geoId: US_GEO_ID,
      f_WT: "2",
      f_TPR: `r${secondsOld}`,
      start: String(start),
      pageNum: "0",
    });
    if (jobType === "fulltime") params.set("f_JT", "F");
    else if (jobType === "contract") params.set("f_JT", "C");

    const res = await fetch(`${SEARCH_URL}?${params}`, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
      },
    });

    if (res.status === 429) {
      throw new Error("LinkedIn rate-limited (429). Try again later.");
    }
    if (!res.ok) {
      throw new Error(`LinkedIn HTTP ${res.status}`);
    }

    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const cards = [...doc.querySelectorAll("div.base-search-card")];
    if (!cards.length) break;

    for (const card of cards) {
      const link = card.querySelector("a.base-card__full-link");
      const href = (link?.getAttribute("href") || "").split("?")[0];
      if (!href) continue;
      const jobId = href.split("-").pop();
      if (!jobId || seen.has(jobId)) continue;
      seen.add(jobId);

      const jobTitle =
        card.querySelector("span.sr-only")?.textContent?.trim() ||
        card.querySelector("h3.base-search-card__title")?.textContent?.trim() ||
        "";
      const company =
        card
          .querySelector("h4.base-search-card__subtitle a")
          ?.textContent?.trim() ||
        card
          .querySelector("h4.base-search-card__subtitle")
          ?.textContent?.trim() ||
        "";
      const location =
        card
          .querySelector("span.job-search-card__location")
          ?.textContent?.trim() || "";

      const timeEl =
        card.querySelector("time.job-search-card__listdate") ||
        card.querySelector("time.job-search-card__listdate--new");
      const datePosted = timeEl?.getAttribute("datetime") || "";

      jobs.push(
        normalizeJob({
          title: jobTitle,
          company,
          location,
          site: "linkedin",
          listing_type: listingType,
          date_posted: datePosted,
          is_remote: true,
          job_url: `${BASE}/jobs/view/${jobId}`,
          description: "",
        })
      );
    }

    start += cards.length;
    if (matchedCount() < resultsWanted) {
      await sleep(2000 + Math.random() * 1500);
    }
  }

  const filtered = filterByRequest(jobs, {
    hoursOld: preset.hoursOld,
    title: titleFilter,
    years,
    jobType,
  });
  onProgress?.(
    `LinkedIn: ${jobs.length} raw → ${filtered.length} matching title`
  );
  return filtered.slice(0, resultsWanted);
}
