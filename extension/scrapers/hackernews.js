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
// Case-sensitive: "US", "ET"/"PT" time zones, ", CA" state codes
const US_TOKEN_RE = new RegExp(
  `\\b(?:US|USA|U\\.S\\.A?\\.?|[ECMP][SD]?T)\\b|,\\s*(?:${US_STATE_CODES})\\b`
);
const US_WORD_RE =
  /\b(?:united states|us[- ](?:only|based)|us time ?zones?|north america|americas|worldwide|anywhere|global(?:ly)?)\b/i;
const NON_US_TOKEN_RE = /\b(?:EU|EMEA|CET|UK|LATAM|APAC)\b/;
const NON_US_WORD_RE =
  /\b(?:europe|european|united kingdom|canada|india|latin america|asia|australia|germany|france|spain|netherlands|poland|israel|brazil|mexico|switzerland|sweden|norway|denmark|finland|ireland|portugal|italy|austria|belgium|singapore|japan|london|berlin|zurich|toronto|vancouver|montreal|paris|amsterdam|dublin|bangalore|bengaluru|tel aviv|madrid|barcelona|lisbon|munich|stockholm|copenhagen|warsaw|sydney|melbourne)\b/i;
const US_IN_BODY_RE =
  /\bauthori[sz]ed to work in the (?:us|u\.s\.|united states)\b|\bus citizens?(?:hip)?\b|\bus persons?\b/i;
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

const isPlaceOrMeta = (seg) =>
  REMOTE_RE.test(seg) ||
  /\b(?:onsite|on-site|hybrid|in-office|visa)\b/i.test(seg) ||
  /[$€£]|\b\d+k\b|\busd\b|\bequity\b/i.test(seg) ||
  /https?:|www\.|\.[a-z]{2,}\//i.test(seg) ||
  globalThis.jbEmploymentKinds(seg).length > 0;

/** Remote and open to the US? "yes" / "no" / "unknown" — from the header. */
function usRemote(header, body) {
  if (!REMOTE_RE.test(header) || NOT_REMOTE_RE.test(header)) return "no";
  if (US_TOKEN_RE.test(header) || US_WORD_RE.test(header)) return "yes";
  if (NON_US_TOKEN_RE.test(header) || NON_US_WORD_RE.test(header)) return "no";
  return US_IN_BODY_RE.test(body) ? "yes" : "unknown";
}

/** The role this post offers: a header part, else a short role line in the body. */
function titleOf(segments, bodyLines, titleQuery) {
  const roles = segments.slice(1).filter((s) => !isPlaceOrMeta(s));
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
  const placeless = !/\b(?:remote|onsite|on-site|hybrid|in[- ]office|office)\b/i.test(header) &&
    !US_TOKEN_RE.test(header) && !US_WORD_RE.test(header) &&
    !NON_US_TOKEN_RE.test(header) && !NON_US_WORD_RE.test(header);
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
      listing_type: segments.filter((s) => globalThis.jbEmploymentKinds(s).length).join(", "),
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
