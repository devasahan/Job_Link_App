/**
 * Work at a Startup (Y Combinator) via a www.workatastartup.com tab: the
 * board's search runs on Algolia with a key the site gives signed-in
 * visitors, so this board needs a free YC account and you signed in.
 * Results carry the full description, so the stack is checked here too.
 * YC's terms of use forbid scraping; the user decides.
 */

import { resolveDatePreset, filterByRequest, reportStoppedEarly } from "./util.js";

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
export async function scrapeWorkAtAStartup({
  title,
  stack,
  resultsWanted,
  datePreset,
  years,
  jobType,
  onProgress,
}) {
  const preset = resolveDatePreset(datePreset);
  onProgress?.("Work at a Startup: opening site tab…");

  const titleFilter = (title || "").trim();
  const response = await chrome.runtime.sendMessage({
    type: "WORKATASTARTUP_SCRAPE",
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
    throw new Error("Work at a Startup: no response from extension background");
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
  onProgress?.(
    `Work at a Startup: ${response.rawCount ?? jobs.length} scanned → ${jobs.length} matching`
  );
  reportStoppedEarly(onProgress, "Work at a Startup", response);
  return jobs.slice(0, resultsWanted);
}
