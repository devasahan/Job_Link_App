/** Shared helpers for JobBridge extension scrapers. */

import "./title-match.js";
import "./job-filters.js";

export const DATE_PRESETS = {
  today: {
    id: "today",
    label: "Today (24 hours)",
    hoursOld: 24,
    wellfound: "today",
    glassdoorFromAge: 1,
    // ZipRecruiter HTML only accepts 1 | 5 | 10 | 30 (not 3)
    ziprecruiterDays: 1,
    // Dice filters.postedDate facet values
    dicePostedDate: "ONE",
    jobrightDaysAgo: 1,
  },
  "3days": {
    id: "3days",
    label: "3 days (72 hours)",
    hoursOld: 72,
    wellfound: "3days",
    glassdoorFromAge: 3,
    // nearest allowed ZR value that covers ~72h
    ziprecruiterDays: 5,
    dicePostedDate: "THREE",
    jobrightDaysAgo: 3,
  },
};

export function resolveDatePreset(id) {
  return DATE_PRESETS[id] || DATE_PRESETS.today;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function stripHtml(html) {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(String(html), "text/html");
  return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
}

export function formatLocation(parts) {
  return parts.filter(Boolean).join(", ");
}

export function tokenizeQuery(q) {
  return String(q || "")
    .replace(/,/g, " ")
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 1);
}

/** Every title word (Sr = Senior, Front-End = Frontend, …) must be in the job title. */
export function titleMatches(jobTitle, title) {
  return globalThis.jbTitleMatches(jobTitle, title);
}

export function filterByTitle(jobs, title) {
  if (!String(title || "").trim()) return jobs;
  return jobs.filter((j) => titleMatches(j.title, title));
}

export function requiredYearsFromText(text) {
  return globalThis.jbRequiredYearsFromText(text);
}

export function yearsFromExperienceLabels(labels) {
  return globalThis.jbYearsFromExperienceLabels(labels);
}

export function employmentKinds(text, opts) {
  return globalThis.jbEmploymentKinds(text, opts);
}

/** Job asks for at most userYears + 0.5. Jobs that never state years stay. */
export function withinExperience(job, years) {
  return globalThis.jbWithinExperience(job, years);
}

/** fulltime | contract. Jobs that never state a type stay. */
export function matchesEmployment(job, jobType) {
  return globalThis.jbMatchesEmployment(job, jobType);
}

export function acceptJob(job, { years, jobType } = {}) {
  return withinExperience(job, years) && matchesEmployment(job, jobType);
}

export function filterByRequest(jobs, { title, years, jobType, hoursOld } = {}) {
  let out = jobs;
  if (hoursOld) out = filterByHoursOld(out, hoursOld);
  if (title) out = filterByTitle(out, title);
  return out.filter((job) => acceptJob(job, { years, jobType }));
}

/** Pass/fail for the posted-date window on one job (unknown dates pass). */
export function withinHours(datePosted, hoursOld) {
  if (!hoursOld || !datePosted) return true;
  const s = String(datePosted).trim();
  const t = Date.parse(s);
  if (Number.isNaN(t)) return true;
  const cutoff = Date.now() - hoursOld * 3600 * 1000;
  // Date-only values parse as UTC midnight; compare by day or recent jobs drop out
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
    return s >= cutoffDay;
  }
  return t >= cutoff;
}

export function filterByStack(jobs, stack) {
  const tokens = tokenizeQuery(stack);
  if (!tokens.length) return jobs;
  return jobs.filter((j) => {
    const blob = `${j.title || ""} ${j.description || ""}`.toLowerCase();
    return tokens.every((t) => blob.includes(t));
  });
}

/** Keep jobs whose date_posted is within hoursOld (when a parseable date exists). */
export function filterByHoursOld(jobs, hoursOld) {
  if (!hoursOld) return jobs;
  return jobs.filter((j) => withinHours(j.date_posted, hoursOld));
}

function resolveYearsRequired(partial) {
  const explicit = partial.years_required;
  if (explicit != null && explicit !== "" && Number.isFinite(Number(explicit))) {
    return Number(explicit);
  }
  const parsed = requiredYearsFromText(partial.description || "");
  return parsed == null ? "" : parsed;
}

export function normalizeJob(partial) {
  const isRemote = partial.is_remote;
  const easyApply = partial.easy_apply;
  const description = partial.description || "";
  return {
    title: partial.title || "",
    company: partial.company || "",
    location: partial.location || "",
    site: partial.site || "",
    listing_type: partial.listing_type || "",
    date_posted: partial.date_posted || "",
    is_remote:
      isRemote === true || isRemote === "Yes"
        ? "Yes"
        : isRemote === false || isRemote === "No"
          ? "No"
          : partial.is_remote || "",
    easy_apply:
      easyApply === true || easyApply === "Yes"
        ? "Yes"
        : easyApply === false || easyApply === "No"
          ? "No"
          : partial.easy_apply || "",
    job_url: partial.job_url || "",
    job_url_direct: partial.job_url_direct || "",
    description,
    years_required: resolveYearsRequired({ ...partial, description }),
  };
}

/** Detect remote from title / location / description text. */
export function detectRemote(...parts) {
  const blob = parts.filter(Boolean).join(" ").toLowerCase();
  return /\b(remote|work from home|\bwfh\b)\b/i.test(blob);
}
