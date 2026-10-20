/**
 * ZipRecruiter via a real browser tab (HTML jobs-search).
 * Extension-origin / API calls are Cloudflare-403'd; page-context works
 * after the tab loads (same pattern as Glassdoor).
 * Cards carry no description, so the stack is matched by ZipRecruiter's
 * keyword search (title + stack).
 */

import { resolveDatePreset, filterByRequest } from "./util.js";

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
export async function scrapeZipRecruiter({
  searchTerm,
  title,
  resultsWanted,
  datePreset,
  years,
  jobType,
  onProgress,
}) {
  const preset = resolveDatePreset(datePreset);
  // ZR public search accepts days=1|5|10|30 only (not 3)
  const days = preset.ziprecruiterDays || 1;
  onProgress?.(
    `ZipRecruiter: opening site tab (posted ≤ ${days} day(s) on site)…`
  );

  const response = await chrome.runtime.sendMessage({
    type: "ZIPRECRUITER_SCRAPE",
    payload: {
      searchTerm: (searchTerm || "").trim() || "remote",
      title: (title || "").trim(),
      resultsWanted,
      days,
      hoursOld: preset.hoursOld,
      datePresetLabel: preset.label,
      years: years ?? "",
      jobType: jobType || "",
    },
  });

  if (!response) {
    throw new Error("ZipRecruiter: no response from extension background");
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
    `ZipRecruiter: ${response.rawCount ?? jobs.length} raw → ${jobs.length} matching title`
  );
  return jobs.slice(0, resultsWanted);
}
