/**
 * Jobspresso — curated remote-only board (WordPress + WP Job Manager).
 * Reads the public jobs RSS feed https://jobspresso.co/jobs/feed/ (the newest
 * 20 jobs). Its robots.txt allows that path but not query strings, so there
 * is one request and no server-side search; everything is filtered here.
 * Jobs arrive in batches (none were posted from 29 Aug to at least 9 Oct
 * 2026), so a short window is often empty; the log names the newest posting.
 * Each item: <title> role, <link>, <pubDate>, <dc:creator> "Company<br>⚲ Location",
 * <content:encoded> full description. The feed has no job type.
 */

import { normalizeJob, resolveDatePreset, filterByRequest, stripHtml } from "./util.js";
import { blockedError } from "./http.js";

const FEED_URL = "https://jobspresso.co/jobs/feed/";
const US_RE =
  /\b(?:united states|usa|u\.s\.a?\.?|us|americas|north america|anywhere|worldwide|global|various us states)\b/i;
const US_STATE_RE =
  /\b(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(text) {
  return String(text || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** Text of <tag>…</tag> (CDATA unwrapped), or "". */
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return "";
  const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : decode(m[1]);
}

/** RSS items → raw jobs. Regex, not DOMParser, so it runs anywhere. */
export function parseJobspressoFeed(xml) {
  return [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(([, item]) => {
    const [company = "", place = ""] = tag(item, "dc:creator").split(/<br\s*\/?>/i);
    return {
      title: decode(tag(item, "title")).trim(),
      link: tag(item, "link").trim(),
      company: decode(stripTags(company)).trim(),
      location: decode(stripTags(place)).replace(/⚲/g, "").replace(/\s+/g, " ").trim(),
      pubDate: tag(item, "pubDate").trim(),
      html: tag(item, "content:encoded") || tag(item, "description"),
    };
  });
}

function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, " ");
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
export async function scrapeJobspresso({
  title,
  stack,
  resultsWanted,
  datePreset,
  years,
  jobType,
  onProgress,
}) {
  const preset = resolveDatePreset(datePreset);
  onProgress?.("Jobspresso: reading the jobs feed…");
  const res = await fetch(FEED_URL, {
    headers: { accept: "application/rss+xml, application/xml, text/xml" },
  });
  const body = await res.text();
  if (!res.ok || !/<rss\b|<channel\b/i.test(body)) {
    // Some networks get a small HTML challenge page instead of the feed
    throw blockedError("jobspresso", res.status, body);
  }

  const items = parseJobspressoFeed(body);
  let notUs = 0;
  const jobs = [];
  for (const item of items) {
    // An empty or bare "Remote" location is unknown, so it stays
    const named = item.location && !/^remote$/i.test(item.location);
    if (named && !US_RE.test(item.location) && !US_STATE_RE.test(item.location)) {
      notUs += 1;
      continue;
    }
    const posted = Date.parse(item.pubDate);
    jobs.push(
      normalizeJob({
        title: item.title,
        company: item.company,
        location: item.location ? `Remote (${item.location})` : "Remote",
        site: "jobspresso",
        listing_type: "",
        date_posted: Number.isNaN(posted) ? "" : new Date(posted).toISOString(),
        is_remote: true,
        easy_apply: false,
        job_url: item.link,
        description: stripHtml(item.html),
      })
    );
  }
  const matched = filterByRequest(jobs, {
    hoursOld: preset.hoursOld,
    title: (title || "").trim(),
    stack,
    years,
    jobType,
  });
  const newest = items
    .map((i) => Date.parse(i.pubDate))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => b - a)[0];
  const newestDay = newest ? new Date(newest).toISOString().slice(0, 10) : "unknown";
  onProgress?.(
    `Jobspresso: ${items.length} newest jobs (newest posted ${newestDay}), ${notUs} not open to the US → ${matched.length} matching`
  );
  return matched
    .slice(0, resultsWanted)
    .map((j) => ({ ...j, date_posted: String(j.date_posted).slice(0, 10) }));
}
