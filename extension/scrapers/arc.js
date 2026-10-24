/**
 * Arc (arc.dev) via a real browser tab (page-context fetch of its US
 * remote-jobs pages; see arc-page.js). Arc has no public API and is behind
 * Cloudflare, so the scrape runs on arc.dev itself. The stack is checked
 * here on the description and tech stack the page data carries.
 */

import { resolveDatePreset, filterByRequest, reportStoppedEarly } from "./util.js";

/**
 * @param {{
 *   title?: string,
 *   stack?: string,
 *   resultsWanted: number,
 *   datePreset?: string,
 *   years?: number | "",
 *   jobType?: string,
 *   onProgress?: (msg: string) => void
 * }} opts
 */
export async function scrapeArc({ title, stack, resultsWanted, datePreset, years, jobType, onProgress }) {
  const preset = resolveDatePreset(datePreset);
  onProgress?.("Arc: opening site tab…");

  const titleFilter = (title || "").trim();
  const response = await chrome.runtime.sendMessage({
    type: "ARC_SCRAPE",
    payload: {
      title: titleFilter,
      resultsWanted,
      hoursOld: preset.hoursOld,
      years: years ?? "",
      jobType: jobType || "",
    },
  });
  if (!response) throw new Error("Arc: no response from extension background");
  if (response.error && !(response.jobs && response.jobs.length)) throw new Error(response.error);

  const jobs = filterByRequest(response.jobs || [], {
    hoursOld: preset.hoursOld,
    title: titleFilter,
    stack,
    years,
    jobType,
  });
  const d = response.dropped || {};
  const why = [
    d.notUs && `${d.notUs} not open to the US`,
    d.tooOld && `${d.tooOld} older than the Posted window`,
    d.title && `${d.title} other titles`,
    d.filters && `${d.filters} failed years/type`,
  ].filter(Boolean);
  onProgress?.(
    `Arc: ${response.pages ?? 0} page(s)${response.source ? ` (from ${response.source})` : ""}, ${response.rawCount ?? jobs.length} scanned → ${jobs.length} matching${why.length ? ` (skipped: ${why.join(", ")})` : ""}`
  );
  reportStoppedEarly(onProgress, "Arc", response);
  return jobs.slice(0, resultsWanted).map((j) => ({ ...j, date_posted: String(j.date_posted).slice(0, 10) }));
}
