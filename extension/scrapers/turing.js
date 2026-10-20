/**
 * Turing (work.turing.com/jobs) — freelance / contract remote roles, many of
 * them AI-training and evaluation work. The jobs page is a client-side app;
 * its data comes from one unauthenticated call that returns the whole board:
 *   POST https://work.turing.com/api/jobs/all
 *   {searchQuery: "", expertise: [], location: [], currentPage: 1, pageSize: 1000}
 *   → {success, jobs: [{id, title, locationType, roleGroup, oneLinerDescription,
 *      description (HTML), createdDate "YYYY-MM-DD HH:MM:SS"}], totalCount}
 * This rests on one third-party adapter (checked July 2026), so it is read
 * defensively. If the extension's request is blocked (Imperva sits in front
 * of the site), the same call runs inside a work.turing.com tab.
 * Every role is contract work, so Type = Full time finds none.
 * Jobs carry no country; only explicit non-US wording drops a job.
 */

import { normalizeJob, resolveDatePreset, filterByRequest, stripHtml, BLOCK_TAG_RE } from "./util.js";

const API = "https://work.turing.com/api/jobs/all";
const BODY = { searchQuery: "", expertise: [], location: [], currentPage: 1, pageSize: 1000 };
// "America", not "Latin America"
const US = String.raw`(?:US|U\.S\.(?:A\.?)?|USA|United States|(?<!(?:Latin|South|Central) )America)(?![\w])`;
// The US as a member of a list of places: "the US", "North America", "the Americas"
const US_MEMBER = String.raw`(?:the )?(?:US|U\.S\.(?:A\.?)?|USA|United States|North America|Americas)(?![\w])`;
// Non-US places for "<place>-only" and "must reside in <place>" (tech-hub cities too)
const PLACE = String.raw`(?:(?:the )?(?:(?:Eastern|Western|Central|Northern|Southern|Southeast(?:ern)?|South|East|West|North|Sub-Saharan) )?(?:Europe|Asia|Africa)|(?:South|Central|Latin) Americ(?:a|an)|LATAM|LatAm|EMEA|APAC|MENA|(?:the )?Middle East|(?:the )?EU|(?:the )?UK|(?:the )?United Kingdom|England|Scotland|Wales|(?:the )?European Union|Canada|Mexico|Brazil|Argentina|Colombia|Chile|Peru|Uruguay|Venezuela|Ecuador|Bolivia|Paraguay|Costa Rica|Guatemala|India|Pakistan|Bangladesh|Sri Lanka|Nepal|(?:the )?Philippines|Vietnam|Indonesia|Malaysia|Thailand|Singapore|China|Hong Kong|Taiwan|Japan|(?:South )?Korea|Australia|New Zealand|Ukraine|Russia|Belarus|Kazakhstan|Uzbekistan|Armenia|Poland|Romania|Bulgaria|Serbia|Hungary|Czechia|(?:the )?Czech Republic|Slovakia|Croatia|Bosnia|Moldova|Lithuania|Latvia|Estonia|Turkey|Türkiye|Israel|Egypt|Morocco|Tunisia|Saudi Arabia|(?:the )?UAE|(?:the )?United Arab Emirates|Nigeria|Kenya|Ghana|Uganda|Tanzania|Ethiopia|Rwanda|South Africa|Germany|France|Spain|Portugal|Italy|(?:the )?Netherlands|Ireland|Sweden|Norway|Denmark|Finland|Switzerland|Austria|Belgium|Greece|Bangalore|Bengaluru|Hyderabad|Pune|Chennai|Mumbai|(?:New )?Delhi|Gurgaon|Gurugram|Noida|Kolkata|Karachi|Lahore|Islamabad|Dhaka|Colombo|Kathmandu|Lagos|Abuja|Nairobi|Kampala|Kigali|Accra|Cairo|Casablanca|Johannesburg|Cape Town|London|Manchester|Edinburgh|Toronto|Vancouver|Montr[eé]al|Ottawa|Calgary|Ontario|Qu[eé]bec|British Columbia|Alberta|S[aã]o Paulo|Rio de Janeiro|Buenos Aires|Bogot[aá]|Medell[ií]n|Mexico City|Guadalajara|Monterrey|Santiago|Lima|Montevideo|Manila|Cebu|Jakarta|Ho Chi Minh City|Hanoi|Kuala Lumpur|Bangkok|Dubai|Abu Dhabi|Riyadh|Istanbul|Tel Aviv|Berlin|Munich|Warsaw|Krak[oó]w|Wroc[lł]aw|Kyiv|Kiev|Lviv|Kharkiv|Bucharest|Sofia|Belgrade|Budapest|Prague|Zagreb|Vilnius|Riga|Tallinn|Dublin|Paris|Madrid|Barcelona|Lisbon|Porto|Amsterdam|Stockholm|Copenhagen|Oslo|Helsinki|Zurich|Vienna|Brussels|Athens|Milan|Rome|Sydney|Melbourne|Auckland|Tokyo|Seoul|Beijing|Shanghai|Shenzhen|Taipei)(?![\w'’])(?!\s+(?:English|Spanish|Portuguese|French|German|GDPR|laws?|regulations?|spelling|format|currency))`;
const WHO = String.raw`(?:candidates|applicants|residents|citizens|people|professionals|engineers|developers|contractors|talent)`;
// "LATAM-only", "India-based candidates only"
const PLACE_ONLY_RE = new RegExp(String.raw`\b${PLACE}(?:[- ]based)?(?: ${WHO})?[- ]only\b`, "i");
// "must reside in Lagos, Nigeria", "only open to candidates from Canada or the
// US": the whole place phrase is read
const PLACE_RULE_RE = new RegExp(
  String.raw`\b(?:(?:must|should|needs? to|required to) (?:currently |also |permanently )?(?:be|reside|be located|be based|live) |(?:only (?:open )?|open only )to (?:${WHO} )?(?:(?:based|located|residing) )?)(?:in|within|from) ([^.;:!?()\n]{1,60})`,
  "gi"
);
const PLACE_IN_RE = new RegExp(PLACE, "i");
// "Vancouver, WA", "Paris, Texas": a US namesake
const US_STATE_IN_RE = new RegExp(
  String.raw`,\s*(?:A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY]|Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming)\b`
);
// The US in the same list: "Canada or the US", "LATAM or North America (EST)"
const US_IN_LIST_RE = new RegExp(
  String.raw`(?:^|,|\/|\bor\b|\band\b|&)\s*(?:in )?${US_MEMBER}(?=\s*(?:$|[,)/.;(]|\bor\b|\band\b|\bonly\b))|(?:\/|\bor\b)\s*${US_MEMBER}(?=\s+time ?zones?)`,
  "i"
);
// …and before a place: "US/LATAM-only", "U.S.-based or LATAM-based", "the US, Canada, and Mexico only"
const US_BEFORE_RE = new RegExp(
  String.raw`\b${US_MEMBER}(?:[- ]based)?\s*(?:,\s*(?:and|or)\s+|\/|,|\bor\b|\band\b|&|\+)\s*(?:(?:the )?[\w.-]+(?: [\w.-]+)?(?:[- ]based)?\s*(?:,\s*(?:and|or)\s+|\/|,|\bor\b|\band\b|&)\s*)*(?:the )?$`,
  "i"
);
// "outside the US", "non-US residents": a non-US rule…
const OUTSIDE_RE = new RegExp(
    String.raw`(?:\bnon[- ]|\boutside (?:of )?(?:the )?)${US}(?![-\s]*(?:time|hours|business (?:hours|day)|working (?:hours|day|time)|friendly|eastern|central|pacific|mountain|[ECMP][SD]?T\b))`,
  "gi"
);
// "not open to candidates outside the US", "including outside the US"
// The negation must govern the phrase: same clause, no US in between
const NEGATED_BEFORE_RE =
  /\b(?:no|not|never|cannot|can't|unable|won't|including|incl|also|even)\b(?:(?!\b(?:US|USA|United States)\b)[^.;,:()–—]){0,40}$/i;
// …unless that phrase is turned away ("Candidates outside the US will not be
// considered"), before any "US-based applicants" take over as the subject
const REFUSED_AFTER_RE =
  /^(?:(?!\b(?:US|U\.S\.|USA)[- ](?:based|residents?|citizens?|persons?|applicants?|candidates?)\b)[^.;])*?\b(?:not (?:be )?(?:eligible|considered|accepted|reviewed|open)|cannot|can't|unable|ineligible|excluded|(?:do not|don't|need not) apply)\b/i;
const WELCOME_AFTER_RE = /^\W*(?:[\w-]+\W+){0,2}(?:welcome|ok|okay|considered)\b/i;
// "Only candidates outside the US…" is a restriction
const ONLY_BEFORE_RE = /\bonly\b[^.;,]{0,40}$/i;
// "unable to engage US-based contractors" refuses the US, not the others
const REFUSES_US_RE = /^\s*(?:[\w-]+\s+){0,3}?(?:the\s+)?(?:US|USA|United States)\b/;
const ONLY_AFTER_RE = /^\s*(?:[\w-]+\s+){0,2}only\b/i;
// "U.S. Eastern", "U.S. persons": the period doesn't end a sentence
const US_GOES_ON_RE =
  /^(?:\(|\/|(?:Eastern|Central|Pacific|Mountain|East|West|Coast|Time|Persons?|Citizens?|Residents?|Based|Government|Department|[ECMP][SD]?T)\b)/;
// A US-only statement elsewhere makes "outside the US" a refusal too
const US_FIRST_RE = new RegExp(
  String.raw`(?<!non[- ])\b(?:US|U\.S\.|USA)[- ]only\b|\bonly (?:open )?to (?:${WHO} )?(?:(?:based|located|residing) )?(?:in |from )?(?:the )?${US}|\b(?:must|should|needs? to|required to) (?:be|reside|be located|be based|live) (?:in|from|within) (?:the )?${US}(?![-\s/(]*(?:[\w-]+\s+){0,3}?(?:time ?zones?|timezones?|time|hours|day|coast|aligned|friendly|compatible|overlap|[ECMP][SD]?T\b))`,
  "i"
);
const US_NAMED_RE = /\b(?:United States|USA)\b|\bU\.S\.(?!\w)/;

const isBlocked = (status, body) => status === 403 || /incapsula/i.test(String(body).slice(0, 3000));

/** The board from the extension page; null when blocked. */
async function fetchBoard() {
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(BODY),
  });
  const raw = await res.text();
  if (isBlocked(res.status, raw)) return null;
  // A tab shares the browser's IP, so it would be limited too
  if (res.status === 429 || res.status === 503) {
    throw new Error(`Turing is limiting requests (HTTP ${res.status}). Wait a few minutes, then retry.`);
  }
  try {
    return { status: res.status, data: JSON.parse(raw) };
  } catch {
    return null;
  }
}

function toJob(row) {
  const text = [row.oneLinerDescription, stripHtml(row.description || "")].filter(Boolean).join("\n");
  const created = String(row.createdDate || "");
  return {
    ...normalizeJob({
      title: String(row.title || "").trim(),
      company: "Turing",
      location: US_NAMED_RE.test(`${row.title} ${text}`) ? "United States" : "Remote",
      site: "turing",
      listing_type: "contract",
      // Time zone unknown: compare by day
      date_posted: /^\d{4}-\d{2}-\d{2}/.test(created) ? created.slice(0, 10) : "",
      is_remote: true,
      easy_apply: false,
      job_url: `https://work.turing.com/jobs?jobId=${row.id}`,
      description: text,
    }),
    _remote: row.locationType,
    _created: created,
    // One line per paragraph or list item, for the location rules
    _lines: [
      row.oneLinerDescription,
      ...stripHtml(String(row.description || "").replace(BLOCK_TAG_RE, "\uE000$&")).split(/\s*\uE000\s*/),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/** True when the job states a non-US location rule. */
function nonUs(job) {
  const text = `${job.title}\n${job._lines ?? job.description}`
    // "U.S." → "US", keeping a period that ends the sentence ("…in the U.S. Familiarity…")
    .replace(/\bU\.S\.(A\.?)?(?=(\s+\S+)?)/g, (m, a, next) => {
      const ends = m.endsWith(".") && /^\s+[A-Z]/.test(next || "") && !US_GOES_ON_RE.test(next.trim());
      return `${a ? "USA" : "US"}${ends ? "." : ""}`;
    })
    // "e.g." doesn't end a sentence
    .replace(/\b(?:e\.g|i\.e|etc|vs|approx|incl)\./gi, (m) => m.replace(/\./g, ""))
    // The pronoun "us" isn't the country ("Tell us", "Send us only…")
    .replace(/(?<!\bnon[- ]|\boutside (?:of )?(?:the )?)\bus\b/g, "_us_");
  const usFirst = US_FIRST_RE.test(text);
  return text.split(/(?<=[.!?;])\s+|\n+/).some((s) => {
    const only = s.match(PLACE_ONLY_RE);
    if (only && !US_BEFORE_RE.test(s.slice(0, only.index))) return true;
    for (const m of s.matchAll(PLACE_RULE_RE)) {
      // "Must be located in the US to support our clients in Europe" is a US rule
      if (/^(?:in )?(?:the )?(?:US|USA|United States|North America)\b/i.test(m[1].trim())) continue;
      if (PLACE_IN_RE.test(m[1]) && !US_IN_LIST_RE.test(m[1]) && !US_STATE_IN_RE.test(m[1])) return true;
    }
    for (const m of s.matchAll(OUTSIDE_RE)) {
      const before = s.slice(0, m.index);
      const after = s.slice(m.index + m[0].length);
      if (/\binside (?:or|and) $/i.test(before) || NEGATED_BEFORE_RE.test(before)) continue;
      if (ONLY_BEFORE_RE.test(before) || ONLY_AFTER_RE.test(after)) return true;
      if (US_BEFORE_RE.test(before) || WELCOME_AFTER_RE.test(after)) continue;
      const refused = after.match(REFUSED_AFTER_RE);
      const refusesUs = refused && REFUSES_US_RE.test(after.slice(refused[0].length));
      if (!usFirst && (!refused || refusesUs)) return true;
    }
    return false;
  });
}

/**
 * @param {{
 *   searchTerm: string,
 *   title?: string,
 *   stack?: string,
 *   resultsWanted: number,
 *   datePreset?: string,
 *   years?: number | "",
 *   jobType?: string,
 *   onProgress?: (msg: string) => void
 * }} opts
 */
export async function scrapeTuring({ title, stack, resultsWanted, datePreset, years, jobType, onProgress }) {
  const preset = resolveDatePreset(datePreset);
  onProgress?.("Turing: reading the job board…");

  let board = await fetchBoard();
  let via = "";
  if (!board) {
    onProgress?.("Turing: blocked from the extension; trying a work.turing.com tab…");
    const reply = await chrome.runtime.sendMessage({ type: "TURING_SCRAPE", payload: { body: BODY } });
    if (!reply || reply.error) throw new Error(reply?.error || "Turing: no response from extension background");
    board = { status: reply.status, data: reply.data };
    via = " (via site tab)";
  }
  const { status, data } = board;
  if (status >= 400 || data?.success !== true || !Array.isArray(data?.jobs)) {
    throw new Error(`Turing returned an unexpected response (HTTP ${status}); the board may have changed`);
  }

  let notRemote = 0;
  let notUs = 0;
  const jobs = [];
  for (const row of data.jobs) {
    const job = toJob(row);
    // Remote-first board: a missing locationType counts as remote
    if (job._remote && job._remote !== "remote") {
      notRemote += 1;
      continue;
    }
    if (nonUs(job)) {
      notUs += 1;
      continue;
    }
    jobs.push(job);
  }
  jobs.sort((a, b) => b._created.localeCompare(a._created));
  const matched = filterByRequest(jobs, {
    hoursOld: preset.hoursOld,
    title: (title || "").trim(),
    stack,
    years,
    jobType,
  });
  const total = Number(data.totalCount);
  const capped = Number.isFinite(total) && data.jobs.length < total ? ` (only ${data.jobs.length} of ${total} returned)` : "";
  onProgress?.(
    `Turing${via}: ${data.jobs.length} roles${capped}, ${notRemote} on-site, ${notUs} not open to the US → ${matched.length} matching` +
      (jobType === "fulltime" ? " (all Turing roles are contract work)" : "")
  );
  return matched.slice(0, resultsWanted).map(({ _remote, _created, _lines, ...job }) => job);
}
