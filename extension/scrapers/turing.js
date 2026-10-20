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

import { normalizeJob, resolveDatePreset, filterByRequest, stripHtml } from "./util.js";

const API = "https://work.turing.com/api/jobs/all";
const BODY = { searchQuery: "", expertise: [], location: [], currentPage: 1, pageSize: 1000 };
const NON_US_RE =
  /\bnon[- ]US\b|\b(?:India|LATAM|Europe|EU|UK|Canada|Brazil)[- ]only\b|\bin non-US countries\b/i;
const OUTSIDE_US_RE = /\boutside (?:of )?(?:the )?(?:US|U\.S\.|United States)\b/i;
// "must reside in Canada" drops a job; "must reside in the United States" doesn't
const MUST_BE_IN_RE =
  /\b[Mm]ust (?:be|reside|be located|be based|live) in (?!the US\b|the U\.S\.|the United States\b|US\b|U\.S\.|United States\b|America\b)[A-Z][a-z]+/;
const US_NAMED_RE = /\b(?:United States|U\.S\.|USA)\b/;

const isBlocked = (status, body) =>
  status === 403 || status === 429 || status === 503 || /incapsula/i.test(String(body).slice(0, 3000));

/** The board from the extension page; null when blocked. */
async function fetchBoard() {
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(BODY),
  });
  const raw = await res.text();
  if (isBlocked(res.status, raw)) return null;
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
  };
}

function nonUs(job) {
  const text = `${job.title}\n${job.description}`;
  return (
    NON_US_RE.test(text) ||
    (OUTSIDE_US_RE.test(text) && !/\binside or outside\b/i.test(text)) ||
    MUST_BE_IN_RE.test(text)
  );
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
  return matched.slice(0, resultsWanted).map(({ _remote, _created, ...job }) => job);
}
