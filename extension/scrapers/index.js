import { scrapeIndeed } from "./indeed.js";
import { scrapeLinkedIn } from "./linkedin.js";
import { scrapeWellfound } from "./wellfound.js";
import { scrapeGlassdoor } from "./glassdoor.js";
import { scrapeZipRecruiter } from "./ziprecruiter.js";
import { scrapeJobright } from "./jobright.js";
import { scrapeDice } from "./dice.js";
import { scrapeHimalayas } from "./himalayas.js";
import { scrapeJobicy } from "./jobicy.js";
import { scrapeHackerNews } from "./hackernews.js";
import { scrapeBuiltin } from "./builtin.js";
import { scrapeJobspresso } from "./jobspresso.js";
import { scrapeWorkAtAStartup } from "./workatastartup.js";
import { scrapeTuring } from "./turing.js";
import {
  acceptJob,
  filterByTitle,
  requiredYearsFromText,
  resolveDatePreset,
} from "./util.js";

const SCRAPERS = {
  indeed: scrapeIndeed,
  linkedin: scrapeLinkedIn,
  wellfound: scrapeWellfound,
  glassdoor: scrapeGlassdoor,
  zip_recruiter: scrapeZipRecruiter,
  jobright: scrapeJobright,
  dice: scrapeDice,
  himalayas: scrapeHimalayas,
  jobicy: scrapeJobicy,
  hackernews: scrapeHackerNews,
  builtin: scrapeBuiltin,
  jobspresso: scrapeJobspresso,
  workatastartup: scrapeWorkAtAStartup,
  turing: scrapeTuring,
};

/**
 * Fetch remote US jobs from selected platforms (no local server).
 * @param {{
 *   sites: string[],
 *   title: string,
 *   stack: string,
 *   count: number,
 *   datePreset?: string,
 *   years?: number | "",
 *   jobType?: "fulltime" | "contract" | "",
 *   onProgress?: (msg: string) => void
 * }} opts
 */
export async function scrapeJobs({
  sites,
  title,
  stack,
  count,
  datePreset,
  years,
  jobType,
  onProgress,
}) {
  const titleQ = (title || "").trim();
  const stackQ = (stack || "").trim();
  // Boards search title + stack, so their full-text search checks the stack
  // on the whole posting. Empty title/stack → broad remote search.
  const searchTerm = [titleQ, stackQ].filter(Boolean).join(" ").trim();
  if (!sites?.length) {
    throw new Error("Select at least one platform");
  }

  const preset = resolveDatePreset(datePreset);
  const resultsWanted = Math.max(1, Math.min(200, Number(count) || 50));
  const all = [];
  const errors = [];

  for (const site of sites) {
    const fn = SCRAPERS[site];
    if (!fn) {
      errors.push(`Unknown platform: ${site}`);
      continue;
    }
    try {
      onProgress?.(`Fetching ${site}…`);
      const jobs = await fn({
        searchTerm,
        title: titleQ,
        stack: stackQ,
        resultsWanted,
        datePreset: preset.id,
        years,
        jobType,
        onProgress,
      });
      all.push(...jobs);
      onProgress?.(`${site}: ${jobs.length} job(s)`);
    } catch (err) {
      const msg = err?.message || String(err);
      errors.push(`${site}: ${msg}`);
      onProgress?.(`${site} failed: ${msg}`);
    }
  }

  // Each scraper already applied the stack while paging, so Count holds
  let jobs = filterByTitle(all, titleQ);
  for (const job of jobs) {
    if (job.years_required == null || job.years_required === "") {
      const parsed = requiredYearsFromText(job.description || "");
      if (parsed != null) job.years_required = parsed;
    }
  }
  jobs = jobs.filter((job) => acceptJob(job, { years, jobType }));

  // One row per title + company, across all platforms (first one wins)
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9+#]+/g, " ")
      .trim();
  const seen = new Set();
  jobs = jobs.filter((j) => {
    const title = norm(j.title);
    const company = norm(j.company);
    // Turing lists every role under its own name: there the link is the identity
    const key = title && company && j.site !== "turing" ? `${title}|${company}` : j.job_url;
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { jobs, errors, datePreset: preset };
}
