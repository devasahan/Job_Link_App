/**
 * Wellfound via a real browser tab (page-context fetch of its public role
 * pages; see wellfound-page.js). Wellfound has no public jobs API, and its
 * pages are bot-protected, so the scrape runs on wellfound.com itself.
 * Listings carry the full description, so the stack is checked here too.
 */

import { resolveDatePreset, filterByRequest } from "./util.js";

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
export async function scrapeWellfound({
  title,
  stack,
  resultsWanted,
  datePreset,
  years,
  jobType,
  onProgress,
}) {
  const preset = resolveDatePreset(datePreset);
  onProgress?.("Wellfound: opening site tab…");

  const titleFilter = (title || "").trim();
  const response = await chrome.runtime.sendMessage({
    type: "WELLFOUND_SCRAPE",
    payload: {
      title: titleFilter,
      stack: (stack || "").trim(),
      resultsWanted,
      hoursOld: preset.hoursOld,
      years: years ?? "",
      jobType: jobType || "",
    },
  });

  if (!response) {
    throw new Error("Wellfound: no response from extension background");
  }
  if (response.error && !(response.jobs && response.jobs.length)) {
    throw new Error(response.error);
  }

  let jobs = response.jobs || [];
  jobs = filterByRequest(jobs, {
    hoursOld: preset.hoursOld,
    title: titleFilter,
    stack,
    years,
    jobType,
  });
  const searched = response.role ? `role "${response.role}"` : "all remote roles";
  const stop = response.hitPageLimit
    ? " (page limit reached)"
    : response.stoppedOld
      ? " (stopped: 3 pages in a row older than the Posted window)"
      : "";
  const d = response.dropped;
  const why = d
    ? [
        d.tooOld && `${d.tooOld} older than the Posted window`,
        d.notUs && `${d.notUs} not open to US remote`,
        d.title && `${d.title} other titles`,
        d.filters && `${d.filters} failed stack/years/type`,
      ].filter(Boolean)
    : [];
  onProgress?.(
    `Wellfound (${searched}): ${response.pages ?? 0} page(s)${stop}, ${response.rawCount ?? jobs.length} scanned → ${jobs.length} matching${why.length ? ` (skipped: ${why.join(", ")})` : ""}`
  );
  return jobs.slice(0, resultsWanted);
}
