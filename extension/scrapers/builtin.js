/**
 * Built In (builtin.com/jobs/remote) via a real browser tab: its search pages
 * are server-rendered HTML behind Cloudflare, which refuses fast or
 * extension-origin clients, so the scrape runs on builtin.com itself, one page
 * every two seconds. Cards carry only a short summary, so the stack is
 * matched by Built In's keyword search (title + stack). Cards have no job
 * type, so jobs stay unless their summary says otherwise.
 * Built In's terms of use forbid automated access; the user decides.
 */

import { resolveDatePreset, filterByRequest, reportStoppedEarly } from "./util.js";

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
export async function scrapeBuiltin({
  searchTerm,
  title,
  resultsWanted,
  datePreset,
  years,
  jobType,
  onProgress,
}) {
  const preset = resolveDatePreset(datePreset);
  onProgress?.("Built In: opening site tab…");

  const response = await chrome.runtime.sendMessage({
    type: "BUILTIN_SCRAPE",
    payload: {
      searchTerm: (searchTerm || "").trim(),
      title: (title || "").trim(),
      resultsWanted,
      days: preset.builtinDays || 1,
      hoursOld: preset.hoursOld,
      years: years ?? "",
      jobType: jobType || "",
    },
  });

  if (!response) {
    throw new Error("Built In: no response from extension background");
  }
  if (response.error && !(response.jobs && response.jobs.length)) {
    throw new Error(response.error);
  }

  const titleFilter = (title || "").trim();
  let jobs = response.jobs || [];
  jobs = filterByRequest(jobs, {
    hoursOld: preset.hoursOld,
    title: titleFilter,
    years,
    jobType,
  });
  onProgress?.(
    `Built In: ${response.rawCount ?? jobs.length} scanned → ${jobs.length} matching`
  );
  reportStoppedEarly(onProgress, "Built In", response);
  return jobs.slice(0, resultsWanted);
}
