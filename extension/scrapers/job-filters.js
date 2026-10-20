/**
 * Experience-year and employment-type checks shared by extension pages
 * and site tabs. Plain script (no import/export) so it can be injected
 * via chrome.scripting.executeScript({ files }).
 *
 * Years: "5+ years of experience", "3-5 years experience", "4 years' experience",
 * "5 or more years of experience", "Experience: 5+ years".
 * A range uses its minimum (the years the job requires).
 * Several mentions use the highest requirement.
 * Company blurbs are skipped ("we have 15 years of experience",
 * "a consultancy with an experience of 12 years", anything above 15 years).
 */
(function () {
  const YEARS_RE =
    /(?:\b(?:at least|minimum(?: of)?|min\.?)\s+)?(\d+(?:\.\d+)?)(?:\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?))?(?:\s*\+|\s+or\s+more|\s+plus)?\s*(?:years?|yrs?)['’]?(?:\s+of)?((?:\s+\.?[a-z][a-z0-9+#./-]*[a-z0-9+#]){0,6}?)\s+experience\b/gi;
  const EXPERIENCE_FIRST_RE =
    /\bexperience(?:\s+(?:required|needed))?\s*(?::|-|–|—|\bof\b)\s*(?:(?:at least|minimum(?: of)?|min\.?)\s+)?(\d+(?:\.\d+)?)(?:\s*(?:-|–|—|to)\s*\d+(?:\.\d+)?)?(?:\s*\+|\s+or\s+more|\s+plus)?\s*(?:years?|yrs?)\b/gi;
  // "We have …", "Our company has over …" right before the number
  const COMPANY_BEFORE_RE =
    /\b(?:we|our\s+[a-z]+(?:\s+(?:team|group|staff|founders?|company|firm))?|the\s+company|company|firm|agency|founders?)\s+(?:has|have|had|brings?|boasts?)\s+(?:(?:over|more\s+than|nearly|almost|about|around)\s+)?$/i;
  // "12 years of combined experience across our leadership" is a blurb;
  // "5+ years of combined experience in backend" is a requirement
  const COMBINED_RE = /\b(?:combined|collective|cumulative)\b/i;
  const COMPANY_WORD_RE = /\b(?:we|our|us|team|founders?|leadership)\b/i;
  // Same sentence, before "experience of N years": the company's history
  // ("Our company, with an experience of 12 years, …")…
  const COMPANY_SENTENCE_RE =
    /\b(?:we|our|company|firm|agency|consultancy|founders?)\b[^.!?\n]*$/i;
  // …always when the company itself takes it ("a staffing firm having experience of 12 years")…
  const COMPANY_TAKES_RE =
    /\b(?:company|firm|agency|consultancy|organi[sz]ation)\s+(?:(?:that|which)\s+)?(?:with|having|has|brings?|bringing)\s+(?:an?\s+)?$/i;
  // …but not when the sentence asks for a person ("We are looking for someone with experience of 5 years")
  const HIRING_RE =
    /\b(?:(?:looking|searching)\s+for|seeking|hiring(?:\s+for)?|needs?|wants?|requires?)\s+(?:an?\s|someone|somebody|candidates?|engineers?|developers?|professionals?)|\bideal\s+candidate\b|\b(?:must|should)\s+have\b/i;
  // "Startup or agency experience of 3+ years" describes the experience
  const MODIFIER_RE =
    /(?:^|[\n:•*-]|\bor|\band|\bhave|\bhas|\bstrong|\bprior)\s*(?:[a-z-]+\s+)?(?:company|firm|agency|consultancy)\s*$/i;
  // Bigger numbers are company history ("25 years of industry experience")
  const MAX_REQUIRED_YEARS = 15;

  function requiredYearsFromText(text) {
    const s = String(text || "");
    let max = null;
    const consider = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n > MAX_REQUIRED_YEARS) return;
      if (max == null || n > max) max = n;
    };
    const re = new RegExp(YEARS_RE.source, YEARS_RE.flags);
    let match;
    while ((match = re.exec(s))) {
      const before = s.slice(Math.max(0, match.index - 60), match.index);
      const n = Number(match[1]);
      const sentence = `${before.split(/[.!?\n]/).pop()} ${
        s.slice(re.lastIndex, re.lastIndex + 80).split(/[.!?\n]/)[0]
      }`;
      const blurb =
        COMPANY_BEFORE_RE.test(before) ||
        (COMBINED_RE.test(match[3] || "") && COMPANY_WORD_RE.test(sentence));
      if (blurb || n > MAX_REQUIRED_YEARS) {
        // Rescan from the skipped "years" (not its number, or "10-12" would
        // re-match "12"): a real requirement may follow
        re.lastIndex = match.index + match[0].search(/years?|yrs?/i) + 1;
        continue;
      }
      consider(match[1]);
    }
    for (const match of s.matchAll(EXPERIENCE_FIRST_RE)) {
      const before = s.slice(Math.max(0, match.index - 80), match.index);
      // "Experience: 5+ years" is a label, never a blurb ("Our Experience: 12 years" is)
      const label =
        /^experience(?:\s+(?:required|needed))?\s*(?::|-|–|—)/i.test(match[0]) && !/\bour\s*$/i.test(before);
      const blurb =
        COMPANY_TAKES_RE.test(before) ||
        (COMPANY_SENTENCE_RE.test(before) &&
          !HIRING_RE.test(before.split(/[.!?\n]/).pop()) &&
          !MODIFIER_RE.test(before));
      if (!label && blurb) continue;
      consider(match[1]);
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

  // Jobs about contracts, not contract jobs: "Contract Manager",
  // "Contracting Officer", "Smart Contracts Engineer"
  const CONTRACT_ROLE_RE =
    /\bcontract(?:s|ing)?\s+(?:manager|management|specialist|administrator|administration|analyst|negotiator|coordinator|officer|compliance)\b|\bsmart\s+contracts?\b/g;

  /**
   * @param {string} text
   * @param {{ bareContract?: boolean, other?: boolean }} [opts]
   */
  function employmentKinds(text, opts = {}) {
    const bareContract = opts.bareContract !== false;
    const other = opts.other !== false;
    const s = String(text || "")
      .toLowerCase()
      .replace(/[_/]+/g, " ")
      .replace(CONTRACT_ROLE_RE, " ");
    const kinds = new Set();
    if (/\bfull[\s-]?time\b|\bfulltime\b/.test(s)) kinds.add("fulltime");
    if (
      /\b(?:contractors?|contracting|freelance|c2c|1099|contract[\s-]?to[\s-]?hire)\b/.test(
        s
      ) ||
      (bareContract && /\bcontract\b/.test(s)) ||
      // Dice lists the type as "CONTRACTS"
      /^\s*contracts\s*$/.test(s) ||
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
