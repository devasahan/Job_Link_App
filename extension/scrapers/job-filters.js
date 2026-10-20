/**
 * Experience-year and employment-type checks shared by extension pages
 * and site tabs. Plain script (no import/export) so it can be injected
 * via chrome.scripting.executeScript({ files }).
 *
 * Years: "5+ years of experience", "3-5 years experience", "4 years' experience".
 * A range uses its minimum (the years the job requires).
 * Several mentions use the highest requirement.
 */
(function () {
  const YEARS_RE =
    /(?:\b(?:at least|minimum(?: of)?|min\.?)\s+)?(\d+(?:\.\d+)?)(?:\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?))?\s*\+?\s*(?:years?|yrs?)['’]?(?:\s+of)?(?:\s+[a-z0-9+#./-]{2,}){0,6}?\s+experience\b/gi;

  function requiredYearsFromText(text) {
    const s = String(text || "");
    let max = null;
    for (const match of s.matchAll(YEARS_RE)) {
      const low = Number(match[1]);
      if (!Number.isFinite(low)) continue;
      if (max == null || low > max) max = low;
    }
    return max;
  }

  /** Indeed-style attribute labels: "5 years", "1 year". */
  function yearsFromExperienceLabels(labels) {
    let max = null;
    for (const label of labels || []) {
      const match = String(label)
        .trim()
        .match(/^(\d+(?:\.\d+)?)\s*\+?\s*years?$/i);
      if (!match) continue;
      const n = Number(match[1]);
      if (!Number.isFinite(n)) continue;
      if (max == null || n > max) max = n;
    }
    return max;
  }

  /**
   * @param {string} text
   * @param {{ bareContract?: boolean, other?: boolean }} [opts]
   */
  function employmentKinds(text, opts = {}) {
    const bareContract = opts.bareContract !== false;
    const other = opts.other !== false;
    const s = String(text || "")
      .toLowerCase()
      .replace(/[_/]+/g, " ");
    const kinds = new Set();
    if (/\bfull[\s-]?time\b|\bfulltime\b/.test(s)) kinds.add("fulltime");
    if (
      /\b(?:contractors?|contracting|freelance|c2c|1099|contract[\s-]?to[\s-]?hire)\b/.test(
        s
      ) ||
      (bareContract && /\bcontract\b/.test(s)) ||
      (!bareContract &&
        /\bcontract\s+(?:role|position|job|opportunity|opening)\b/.test(s)) ||
      (!bareContract &&
        /\b(?:job|employment|position)\s+type\s*[:\-]?\s*contract\b/.test(s))
    ) {
      kinds.add("contract");
    }
    if (
      other &&
      /\b(?:part[\s-]?time|parttime|intern(?:ship)?|temporary|temp)\b/.test(s)
    ) {
      kinds.add("other");
    }
    return [...kinds];
  }

  function detectEmployment(job) {
    const listing = employmentKinds(job?.listing_type || "");
    if (listing.length) return listing;
    const title = employmentKinds(job?.title || "");
    if (title.length) return title;
    // Descriptions say "contract" in passing. Only count explicit type phrases.
    return employmentKinds(job?.description || "", {
      bareContract: false,
      other: false,
    });
  }

  function matchesEmployment(job, jobType) {
    const want =
      jobType === "contract" ? "contract" : jobType === "fulltime" ? "fulltime" : "";
    if (!want) return true;
    const kinds = detectEmployment(job);
    if (!kinds.length) return true;
    return kinds.includes(want);
  }

  /** Keep the job when it asks for years <= userYears + 0.5. Unstated years stay. */
  function withinExperience(job, years) {
    if (years == null || years === "") return true;
    const limit = Number(years) + 0.5;
    if (!Number.isFinite(limit)) return true;
    const required = job?.years_required;
    if (required == null || required === "") return true;
    const n = Number(required);
    if (!Number.isFinite(n)) return true;
    return n <= limit + 1e-9;
  }

  globalThis.jbRequiredYearsFromText = requiredYearsFromText;
  globalThis.jbYearsFromExperienceLabels = yearsFromExperienceLabels;
  globalThis.jbEmploymentKinds = employmentKinds;
  globalThis.jbMatchesEmployment = matchesEmployment;
  globalThis.jbWithinExperience = withinExperience;
})();
