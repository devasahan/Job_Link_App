/**
 * Dice.com via a real browser tab.
 * Search HTML embeds Next.js RSC flight data with jobList; extension-origin
 * fetches can be blocked, so scrape runs in page context (Jobright pattern).
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
export async function scrapeDice({
  searchTerm,
  title,
  resultsWanted,
  datePreset,
  years,
  jobType,
  onProgress,
}) {
  const preset = resolveDatePreset(datePreset);
  onProgress?.("Dice: opening site tab…");

  const response = await chrome.runtime.sendMessage({
    type: "DICE_SCRAPE",
    payload: {
      searchTerm: (title || searchTerm || "").trim(),
      title: (title || "").trim(),
      resultsWanted,
      hoursOld: preset.hoursOld,
      postedDate: preset.dicePostedDate || "ONE",
      datePresetLabel: preset.label,
      years: years ?? "",
      jobType: jobType || "",
    },
  });

  if (!response) {
    throw new Error("Dice: no response from extension background");
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
    `Dice: ${response.rawCount ?? jobs.length} raw → ${jobs.length} matching title`
  );
  return jobs.slice(0, resultsWanted);
}
