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
import { normalizeWords } from "./history.js";

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
 *   downloaded?: { has(job): boolean, recentCount(site: string, hours: number): number },
 *   onProgress?: (msg: string) => void
 * }} opts
 * With `downloaded`, jobs from earlier downloads are left out (counted in
 * `skipped`) and each board is asked for more, so Count new jobs still fit.
 */
export async function scrapeJobs({
  sites,
  title,
  stack,
  count,
  datePreset,
  years,
  jobType,
  downloaded,
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
      // Jobs downloaded before may fill this board's first results again
      const repeats = downloaded ? downloaded.recentCount(site, preset.hoursOld) : 0;
      const jobs = await fn({
        searchTerm,
        title: titleQ,
        stack: stackQ,
        resultsWanted: Math.min(400, resultsWanted + repeats),
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
  const seen = new Set();
  jobs = jobs.filter((j) => {
    const title = normalizeWords(j.title);
    const company = normalizeWords(j.company);
    // Turing lists every role under its own name: there the link is the identity
    const key = title && company && j.site !== "turing" ? `${title}|${company}` : j.job_url;
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Leave out earlier downloads, then Count per board again
  let skipped = 0;
  if (downloaded) {
    const perSite = {};
    jobs = jobs.filter((j) => {
      if (downloaded.has(j)) {
        skipped += 1;
        return false;
      }
      perSite[j.site] = (perSite[j.site] || 0) + 1;
      return perSite[j.site] <= resultsWanted;
    });
  }

  return { jobs, errors, skipped, datePreset: preset };
}
