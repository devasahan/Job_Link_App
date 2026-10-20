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
    /\b(?:company|firm|agency|consultancy)\s+(?:(?:that|which)\s+)?(?:with|having|has|brings?|bringing)\s+(?:an?\s+)?$|\b(?:we|our\s+(?:[a-z]+\s+)?(?:team|company|firm|agency|consultants|recruiters|founders?))(?:,?\s+(?:that|which|who))?\s+(?:(?:also|now)\s+)?(?:bring|brings|have|has|boast|boasts)\s+(?:an?\s+)?$|\b(?:client|partner),\s+an?\s+(?:[\w-]+\s+){0,3}(?:company|firm|organi[sz]ation|business|startup)\s+(?:with|having|that\s+has)\s+(?:an?\s+)?$/i;
  // …but not when the sentence asks for a person ("We are looking for someone with experience of 5 years")
  // (a hiring verb of the reader or the firm's clients doesn't count: "Whether
  // you need a developer or a team, we bring an experience of 12 years")
  const HIRING_RE =
    /(?<!\b(?:you|you're|you\s+are|your\s+\w+|companies|clients|businesses|enterprises|startups|organi[sz]ations|employers)(?:\s+(?:that|who))?\s+)\b(?:(?:looking|searching)\s+for|seeking|hiring(?:\s+for)?|needs?|wants?|requires?)\s+(?:an?\s|someone|somebody|candidates?|engineers?|developers?|professionals?)|\bideal\s+candidate\b|\b(?:must|should)\s+have\b|\bjoin\s+(?:our|the)\b|\bwhat\s+(?:we're|we\s+are)\s+looking\s+for\b|\b(?:requirements|qualifications)\b/i;
  // "- Startup or agency experience of 3+ years", "Must have agency experience
  // of 3 years" describe the experience ("We have agency experience…" doesn't)
  const MODIFIER_RE =
    /(?:(?:^|[\n:•*])\s*[-•*]?|\b(?:must|should)\s+have)\s*(?:(?:strong|prior|proven|some)\s+)?(?:[a-z-]+\s+(?:or|and)\s+)?(?:[a-z-]+\s+)?(?:company|firm|agency|consultancy)\s*$/i;
  // "We are an IT staffing company | Experience: 12+ years" is a profile
  const COMPANY_INTRO_RE = /\bwe\s+are\s+an?\s+[^.!?\n]*\b(?:company|firm|agency|consultancy)\b[^.!?\n]*$/i;
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
      // "3+ years of experience required – 5+ preferred", "No experience needed – 2 years of training"
      if (
        /^experience\s+(?:required|needed)/i.test(match[0]) &&
        (/\d\s*\+?\s*(?:years?|yrs?)['’]?(?:\s+of)?(?:\s+[a-z][\w+#./-]*){0,6}\s*$/i.test(before) ||
          /\bno\s+(?:prior\s+|previous\s+)?$/i.test(before))
      ) {
        continue;
      }
      // "Experience: 5+ years" starting a line or field is a label, never a blurb
      // ("Our industry experience: 12 years", "deep domain experience - 12 years" aren't labels)
      const label =
        /^experience(?:\s+(?:required|needed))?\s*(?::|-|–|—)/i.test(match[0]) &&
        /(?:^|[\n|•*:.;]|\s-\s)\s*[-•*]?\s*$/.test(before) &&
        !COMPANY_INTRO_RE.test(before);
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
