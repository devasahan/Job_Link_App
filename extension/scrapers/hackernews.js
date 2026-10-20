/**
 * Hacker News "Ask HN: Who is hiring?" — the monthly thread posted by the
 * whoishiring account, read through the public HN Algolia API (two GETs):
 *   search_by_date?tags=story,author_whoishiring           → newest threads
 *   search_by_date?tags=comment,story_<id>&numericFilters=created_at_i>…
 *                                                           → the window's comments
 * Each top-level comment is one company's post. Its first line usually reads
 * "Company | Role | Location | REMOTE | …". Threads go up at 11:00 New York
 * time on the first weekday of the month and most posts arrive in the first
 * 1-3 days, so short windows find few posts later in the month.
 * Remote / US is judged on that first line (plus the next two lines when the
 * first names no place or arrangement): bodies of on-site posts often say
 * "global" or "worldwide".
 */

import { normalizeJob, resolveDatePreset, filterByRequest } from "./util.js";
import { readJson } from "./http.js";

const API = "https://hn.algolia.com/api/v1";
const ITEM_URL = "https://news.ycombinator.com/item?id=";
const MAX_THREAD_AGE_DAYS = 45;

const ROLE_RE =
  /\b(?:engineers?|developers?|swe|sde|programmers?|architects?|scientists?|designers?|devops|sre|cto|founding|full[- ]?stack|front[- ]?end|back[- ]?end|roles|positions)\b/i;
const GENERIC_ROLE_RE = /\b(?:multiple|various|several|many|all|open)\b.*\b(?:roles|positions)\b/i;
const SEEKER_RE =
  /\b(?:seeking|looking for (?:a )?(?:job|work|role|position)|open to work|available for)\b|\bdisponible\b/i;
const REMOTE_RE = /\bremote\b/i;
const NOT_REMOTE_RE = /\b(?:no|not|isn'?t)\s+remote\b|\bremote\s*:?\s*no\b/i;
const US_STATE_CODES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";
// The US itself: case-sensitive "US", "U.S." (also before a space), "PST"
const US_NAMED_RE = /\b(?:USA?|[ECMP][SD]T)\b|\bU\.S\.(?:A\.?)?(?!\w)/;
const US_NAMED_WORD_RE = /\b(?:united states|us[- ](?:only|based)|us time ?zones?)\b/i;
// ", TX" after a city ("Austin, TX/Remote" too); "AR/VR" isn't Arkansas
const US_STATE_RE = new RegExp(`,\\s*(${US_STATE_CODES})\\b(?!/(?:VR|XR|MR)\\b)`, "g");
// Bare "ET", "PT", "CT", "MT"
const US_ZONE_RE = /\b([ECMP]T)\b/g;
// "PT/FT", "PT, 20 hours/week": part-time, not Pacific Time ("PT, 4h overlap" is)
const PART_TIME_RE =
  /^PT(?:\s*\/\s*FT\b|\s*[,–-]?\s*\d+\s*(?:hours|hrs|h)\s*(?:\/|per|a)\s*(?:week|wk)\b)|FT\s*\/\s*$/;
// Cities whose country code is also a US state or zone: "Berlin, DE", "Lisbon, PT"
const CITY_COUNTRY = {
  DE: /\b(?:berlin|munich|münchen|hamburg|frankfurt|cologne|köln|stuttgart|düsseldorf|dusseldorf|leipzig|dresden)\b/i,
  IN: /\b(?:bangalore|bengaluru|hyderabad|pune|mumbai|delhi|chennai|gurgaon|gurugram|noida|kolkata|ahmedabad)\b/i,
  IL: /\b(?:tel aviv|jerusalem|haifa|herzliya)\b/i,
  CA: /\b(?:toronto|vancouver|montr[eé]al|ottawa|calgary|edmonton|winnipeg|qu[eé]bec)\b/i,
  CO: /\b(?:bogot[aá]|medell[ií]n)\b/i,
  AR: /\b(?:buenos aires|c[oó]rdoba)\b/i,
  PT: /\b(?:lisbon|lisboa|porto|braga|coimbra)\b/i,
  MT: /\b(?:valletta|sliema)\b/i,
  MA: /\b(?:casablanca|rabat)\b/i,
  ID: /\b(?:jakarta|bandung)\b/i,
  AL: /\btirana\b/i,
  AZ: /\bbaku\b/i,
  TN: /\btunis\b/i,
  ET: /\baddis ababa\b/i,
};
// Regions that include the US; "anywhere in Europe" doesn't
const US_REGION_RE =
  /\b(?:north america|americas|worldwide|global(?:ly)?)\b|\banywhere\b(?!\s+(?:in|within)\b(?!\s+the\s+(?:world|globe)\b))/i;
const NON_US_TOKEN_RE = /\b(?:EU|EMEA|CET|UK|LATAM|APAC)\b/;
const NON_US_WORD_RE =
  /\b(?:europe|european|united kingdom|canada|india|latin america|asia|australia|germany|france|spain|netherlands|poland|israel|brazil|mexico|switzerland|sweden|norway|denmark|finland|ireland|portugal|italy|austria|belgium|singapore|japan|london|berlin|zurich|toronto|vancouver|montreal|paris|amsterdam|dublin|bangalore|bengaluru|tel aviv|madrid|barcelona|lisbon|munich|stockholm|copenhagen|warsaw|sydney|melbourne)\b/i;
// "excluding US", "non-US", "outside the US" (not "US-sanctioned countries")
const US_EXCLUSION_RE =
  /\b(?:(excluding|except)(?:\s+(?:for\s+)?the)?[\s-]+|non[- ]|outside\s+(?:of\s+)?(?:the\s+)?)(?:US|USA|U\.S\.(?:A\.?)?)(?!\w|\.\w|[\s-]*(?:sanction|embargo|ofac|west|east|pacific|mountain|central|eastern|western|time|hours|coast))/gi;
const NEGATED_BEFORE_RE =
  /\b(?:no|not|never|can'?t|cannot|unable|won'?t|including|incl|also|plus|even)\b[^|()]{0,25}$/i;
const WELCOME_AFTER_RE = /^[^|()]{0,20}\b(?:ok|okay|welcome|fine|considered|possible|too|also|as well)\b/i;
// "non-US" standing as the region: "(non-US)", ", outside US.", "only hire outside the US"
const REGION_BEFORE_RE =
  /(?:^|[(,/;:|]|\bremote|\s[-–—]|\bonly\b(?:\s+\w+){0,2}|\b(?:anywhere|worldwide|global|americas?|latam|europe|emea|apac))\s*$/i;
const REGION_AFTER_RE = /^\s*(?:$|[),/;|.])/;
const US_IN_BODY_RE =
  /\bauthori[sz]ed to work in the (?:us|u\.s\.|united states)\b|\bus citizens?(?:hip)?\b|\bus persons?\b/i;
const KIND_LABELS = { fulltime: "Full-time", contract: "Contract", other: "Part-time / intern / temp" };
const ATS_RE =
  /greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters|recruitee|bamboohr|rippling|workday|jobs\.|\/jobs|\/careers/i;

const decode = (text) =>
  String(text || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Comment HTML → plain lines. HN uses a bare <p> between paragraphs. */
function linesOf(html) {
  return decode(String(html || "").replace(/<\/?p>|<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, ""))
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** The first line: comment HTML up to the first <p> or newline. */
function headerOf(html) {
  const first = String(html || "").split(/<p>|\n/i)[0];
  return decode(first.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 200);
}

function segmentsOf(header) {
  for (const sep of [/\s*\|\s*/, /\s+—\s+/, /\s+–\s+/, /\s+·\s+/]) {
    const parts = header.split(sep).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) return parts;
  }
  return [header];
}

// "acme.com", "jobs.lever.co/acme"; not "ASP.NET" or "Socket.io)"
const URL_RE = /https?:|www\.|\b[\w-]+\.(?:com|io|ai|co|org|net|dev|app|jobs|so|xyz|tech)(?:\/|$)/i;
// Pay amounts: "$150k", "USD 150k-190k", "$90-120/hr"
const PAY_AMOUNT_RE = /(?:[$€£]|\b(?:USD|EUR|GBP)\s?)\s?\d[\d,.]*\s*k?|\b\d+(?:\.\d+)?\s*k\b|\/\s*(?:hr|hour|yr|year)\b/gi;
// Words that only say where, how, how long or for how much
const META_WORD_RE = new RegExp(
  String.raw`\b(?:remote|onsite|on-site|hybrid|in-office|office|visa(?:\s+sponsorship)?|equity|base|ote|full[- ]?time|part[- ]?time|contract(?:or)?|contract[- ]to[- ]hire|freelance|intern(?:ship)?|temporary|w2|1099|c2c|months?|weeks?|worldwide|global(?:ly)?|anywhere|north america|americas|united states|usa?|eu|uk|emea|cet|latam|apac|only|based|preferred|ok|okay|friendly|first|or|and|in|from|within|the|time ?zones?|timezones?|hours?|overlap)\b|${NON_US_WORD_RE.source}`,
  "gi"
);
const WORK_MODE_RE = /\b(?:remote|onsite|on-site|hybrid|in-office)\b/i;

const isPlaceOrMeta = (seg) =>
  REMOTE_RE.test(seg) ||
  /\b(?:onsite|on-site|hybrid|in-office|visa)\b/i.test(seg) ||
  /[$€£]|\b\d+k\b|\busd\b|\bequity\b/i.test(seg) ||
  URL_RE.test(seg) ||
  globalThis.jbEmploymentKinds(seg).length > 0;

/** The city just before ", XX": "Remote or Berlin, DE" → "Berlin". */
const cityBefore = (text, index) =>
  text.slice(0, index).split(/[|;()/,]|\s+(?:or|and|&)\s+/).pop().trim();

/**
 * Names the US: "US", "U.S.", "United States", "PST", a state after a city
 * ("Austin, TX") or a US time zone ("PT/ET hours"). Not "Berlin, DE",
 * "Bangalore, IN", "Lisbon, PT" or "PT/FT".
 */
function namesUs(text, { codes = true } = {}) {
  if (US_NAMED_RE.test(text) || US_NAMED_WORD_RE.test(text)) return true;
  if (!codes) return false;
  for (const m of text.matchAll(US_STATE_RE)) {
    if (!CITY_COUNTRY[m[1]]?.test(cityBefore(text, m.index))) return true;
  }
  for (const m of text.matchAll(US_ZONE_RE)) {
    if (PART_TIME_RE.test(text.slice(m.index)) || PART_TIME_RE.test(text.slice(0, m.index))) continue;
    const comma = text.slice(0, m.index).match(/,\s*$/);
    if (comma && CITY_COUNTRY[m[1]]?.test(cityBefore(text, comma.index))) continue;
    return true;
  }
  return false;
}

/**
 * Phrases that rule the US out: "excluding US", and "non-US" / "outside the
 * US" when they are the region itself ("Remote (non-US)", "outside US only",
 * "We only hire outside the US."), not a side note ("no visa for non-US
 * citizens", "can't hire outside the US", "outside the US OK", "US and non-US").
 */
function usExclusions(text) {
  const found = [];
  for (const m of text.matchAll(US_EXCLUSION_RE)) {
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    if (NEGATED_BEFORE_RE.test(before) || WELCOME_AFTER_RE.test(after)) continue;
    if (
      m[1] ||
      /^\s*(?:[\w-]+\s+){0,2}only\b/i.test(after) ||
      (REGION_BEFORE_RE.test(before) && REGION_AFTER_RE.test(after))
    ) {
      found.push(m[0]);
    }
  }
  return found;
}

const namesPlace = (text) =>
  namesUs(text) ||
  US_REGION_RE.test(text) ||
  usExclusions(text).length > 0 ||
  NON_US_TOKEN_RE.test(text) ||
  NON_US_WORD_RE.test(text);

/** Remote and open to the US? "yes" / "no" / "unknown" — from the header. */
function usRemote(header, body) {
  if (!REMOTE_RE.test(header) || NOT_REMOTE_RE.test(header)) return "no";
  // "Remote (Americas, excluding US)": only the US named elsewhere keeps it
  const excluded = usExclusions(header);
  if (excluded.length) {
    return namesUs(excluded.reduce((t, x) => t.replace(x, " "), header)) ? "yes" : "no";
  }
  // "Remote (US/Canada)": the US named, so a second region doesn't matter
  if (namesUs(header) || US_REGION_RE.test(header)) return "yes";
  // "Remote (anywhere in Europe)", "Remote or Berlin, DE"
  if (NON_US_TOKEN_RE.test(header) || NON_US_WORD_RE.test(header)) return "no";
  return US_IN_BODY_RE.test(body) ? "yes" : "unknown";
}

/**
 * Only place, pay or employment type: "Remote, US only", "$150k",
 * "Full-time", "Hybrid (NYC) or Remote". Not "US Payments" or "Smart
 * Contract Security", where a specialty is left over.
 */
function isMetaText(text) {
  const rest = text
    .replace(PAY_AMOUNT_RE, " ")
    .replace(META_WORD_RE, " ")
    .replace(/[^\p{L}\s]/gu, " ")
    .trim();
  if (!rest) return true;
  // A work mode plus a short place: "Remote/SF", "Hybrid (NYC) or Remote"
  return WORK_MODE_RE.test(text) && /^(?:[A-Z][\p{L}.'-]*\s*){1,2}$/u.test(rest);
}

// The last part after " - ", "—", ",", ":" or "/"
const TAIL_RE = /(?:\s+-\s+|\s*[–—,:/]\s*)((?:(?!\s+-\s+|[–—,:/]).)+)$/;

/**
 * The role words of a header part: "Senior Engineer (Remote, US)",
 * "Engineer, Full-time", "Engineer — $180k + equity" and "Engineer – US only"
 * → "… Engineer". "Software Engineer (Backend)" keeps its specialty.
 */
function cleanRole(seg) {
  let s = seg
    .replace(/\(([^)]*)\)/g, (m, inner) => (isMetaText(inner) ? " " : m))
    // Pay runs to the end: "— $180k + equity", ", 150k-200k", "up to $200k"
    .replace(/\s*(?:[-–—,:~@]\s*|\bup\s+to\s+)*(?:(?:[$€£]|\b(?:USD|EUR|GBP)\s?)\s?\d|\b\d+(?:\.\d+)?\s*k\b).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  for (let m = s.match(TAIL_RE); m && isMetaText(m[1]); m = s.match(TAIL_RE)) {
    s = s.slice(0, m.index).trim();
  }
  return s;
}

/** The role this post offers: a header part, else a short role line in the body. */
function titleOf(segments, bodyLines, titleQuery) {
  const roles = segments
    .slice(1)
    .map(cleanRole)
    // A part that names a role but is also pay, type or place stays; a link doesn't
    .filter(
      (s) =>
        s &&
        !URL_RE.test(s) &&
        // "Full-time roles", "Visa sponsorship for engineers" are not roles
        (ROLE_RE.test(s.replace(/\b(?:roles|positions)\b|\bfor\s+\w+\s*$/gi, "")) || !isPlaceOrMeta(s))
    );
  if (titleQuery) {
    const hit = roles.find((s) => globalThis.jbTitleMatches(s, titleQuery));
    if (hit) return hit;
  }
  const role = roles.find((s) => ROLE_RE.test(s) && !GENERIC_ROLE_RE.test(s));
  if (role && !titleQuery) return role;
  // "Multiple roles": the body lists them
  const line = bodyLines.find(
    (l) =>
      l.length <= 100 &&
      (titleQuery ? globalThis.jbTitleMatches(l, titleQuery) : ROLE_RE.test(l))
  );
  return line || role || "";
}

function directLink(html) {
  const links = [...String(html || "").matchAll(/href="([^"]+)"/gi)]
    .map((m) => decode(m[1]))
    .filter((u) => /^https?:\/\//i.test(u) && !/news\.ycombinator\.com/i.test(u));
  return links.find((u) => ATS_RE.test(u)) || links[0] || "";
}

function toJob(hit, titleQuery) {
  const html = String(hit.comment_text || "");
  const header = headerOf(html);
  const segments = segmentsOf(header);
  if (segments.length < 2 || SEEKER_RE.test(header)) return { skip: "not a job post" };
  const lines = linesOf(html);
  const body = lines.join("\n");
  const bodyLines = lines.slice(1).map((l) => l.replace(/^[*•·-]+\s*/, "").trim());
  // "Company | Full time | url": where the work happens is on the next lines
  const placeless =
    !/\b(?:remote|onsite|on-site|hybrid|in[- ]office|office)\b/i.test(header) && !namesPlace(header);
  const where = usRemote(placeless ? `${header} | ${bodyLines.slice(0, 2).join(" | ")}` : header, body);
  if (where === "no") return { skip: "not US-remote" };
  const company = segments[0]
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
  const place = segments.filter((s) => REMOTE_RE.test(s)).slice(0, 2).join(", ");
  return {
    job: normalizeJob({
      title: titleOf(segments, bodyLines, titleQuery),
      company,
      location: where === "unknown" ? "Remote (region unspecified)" : place || "Remote",
      site: "hackernews",
      // "Contract Software Engineer" → "Contract", not the whole part
      listing_type: [...new Set(segments.flatMap((s) => globalThis.jbEmploymentKinds(s)))]
        .map((k) => KIND_LABELS[k])
        .join(", "),
      // Full timestamp while filtering; trimmed to the day for the sheet
      date_posted: new Date(Number(hit.created_at_i) * 1000).toISOString(),
      is_remote: true,
      easy_apply: false,
      job_url: `${ITEM_URL}${hit.objectID}`,
      job_url_direct: directLink(html),
      description: body,
    }),
  };
}

async function getJson(url) {
  const res = await fetch(url);
  const data = await readJson(res, "hackernews", "Hacker News");
  if (!res.ok) throw new Error(`Hacker News HTTP ${res.status}`);
  return data;
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
export async function scrapeHackerNews({
  title,
  stack,
  resultsWanted,
  datePreset,
  years,
  jobType,
  onProgress,
}) {
  const preset = resolveDatePreset(datePreset);
  const titleFilter = (title || "").trim();
  const cutoffSec = Math.floor(Date.now() / 1000) - preset.hoursOld * 3600;

  const stories = await getJson(
    `${API}/search_by_date?${new URLSearchParams({
      tags: "story,author_whoishiring",
      hitsPerPage: "10",
      attributesToRetrieve: "objectID,title,created_at_i",
      attributesToHighlight: "none",
    })}`
  );
  // The account posts "Who wants to be hired?" at the same moment
  const threads = (stories?.hits || []).filter((h) => /^Ask HN: Who is hiring\?/i.test(h.title || ""));
  const [latest, previous] = threads;
  if (!latest || Date.now() / 1000 - Number(latest.created_at_i) > MAX_THREAD_AGE_DAYS * 86400) {
    throw new Error("Hacker News: no 'Who is hiring?' thread from the last 45 days");
  }
  // A window reaching back past the newest thread also covers last month's
  const ids = [latest.objectID];
  if (previous && cutoffSec < Number(latest.created_at_i)) ids.push(previous.objectID);
  onProgress?.(`Hacker News: reading "${latest.title}"${ids.length > 1 ? " and last month's" : ""}…`);

  const storyTag = ids.length > 1 ? `(${ids.map((id) => `story_${id}`).join(",")})` : `story_${ids[0]}`;
  const hits = [];
  for (let page = 0; page < 3; page++) {
    const data = await getJson(
      `${API}/search_by_date?${new URLSearchParams({
        tags: `comment,${storyTag}`,
        numericFilters: `created_at_i>${cutoffSec}`,
        hitsPerPage: "1000",
        page: String(page),
        attributesToRetrieve: "objectID,comment_text,created_at_i,parent_id,story_id,author",
        attributesToHighlight: "none",
      })}`
    );
    hits.push(...(data?.hits || []));
    if (page + 1 >= Number(data?.nbPages || 1)) break;
  }

  // Top-level posts only: replies hang off other comments
  const posts = hits
    .filter((h) => h.comment_text && ids.includes(String(h.parent_id)))
    .sort((a, b) => Number(b.created_at_i) - Number(a.created_at_i));
  const skipped = {};
  const candidates = [];
  for (const post of posts) {
    const { job, skip } = toJob(post, titleFilter);
    if (skip) skipped[skip] = (skipped[skip] || 0) + 1;
    else candidates.push(job);
  }
  const matched = filterByRequest(candidates, {
    hoursOld: preset.hoursOld,
    title: titleFilter,
    stack,
    years,
    jobType,
  });
  const why = Object.entries(skipped).map(([k, n]) => `${n} ${k}`);
  onProgress?.(
    `Hacker News: ${posts.length} posts in the window${why.length ? ` (${why.join(", ")})` : ""} → ${matched.length} matching`
  );
  return matched
    .slice(0, resultsWanted)
    .map((j) => ({ ...j, date_posted: String(j.date_posted).slice(0, 10) }));
}
