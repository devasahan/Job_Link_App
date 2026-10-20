/**
 * Glassdoor via a real browser tab (page-context fetch).
 * Extension-origin requests are Cloudflare-403'd; same-origin from
 * www.glassdoor.com works after the tab loads.
 * Searched with title + stack; Glassdoor's keyword search matches the stack.
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
export async function scrapeGlassdoor({
  searchTerm,
  title,
  resultsWanted,
  datePreset,
  years,
  jobType,
  onProgress,
}) {
  const preset = resolveDatePreset(datePreset);
  onProgress?.("Glassdoor: opening site tab (bypasses Cloudflare)…");

  const response = await chrome.runtime.sendMessage({
    type: "GLASSDOOR_SCRAPE",
    payload: {
      searchTerm: (searchTerm || "").trim() || "remote",
      title: (title || "").trim(),
      resultsWanted,
      fromAge: preset.glassdoorFromAge,
      datePresetLabel: preset.label,
      years: years ?? "",
      jobType: jobType || "",
    },
  });

  if (!response) {
    throw new Error("Glassdoor: no response from extension background");
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
    `Glassdoor: ${response.rawCount ?? jobs.length} raw → ${jobs.length} matching title`
  );
  reportStoppedEarly(onProgress, "Glassdoor", response);
  return jobs.slice(0, resultsWanted);
}
