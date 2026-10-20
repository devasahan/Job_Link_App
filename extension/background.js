/**
 * Background service worker.
 * - Keeps declarativeNetRequest host access alive
 * - Runs Glassdoor / ZipRecruiter / Jobright / Dice / Wellfound scrapes inside real site tabs (avoids CF 403)
 */

import { FALLBACK_CSRF, GLASSDOOR_QUERY } from "./scrapers/glassdoor-query.js";
import { jobrightSearchUrl } from "./scrapers/jobright.js";

const GD_URL = "https://www.glassdoor.com/Job/remote-jobs.htm";
const WF_URL = "https://wellfound.com/remote";
const ZR_URL = "https://www.ziprecruiter.com/jobs-search?search=remote&remote=1";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Serialize tab create/update across Glassdoor + ZipRecruiter. */
let tabOpQueue = Promise.resolve();
function enqueueTabOp(fn) {
  const next = tabOpQueue.then(fn, fn);
  tabOpQueue = next.catch(() => {});
  return next;
}

function waitTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Tab timed out loading"));
    }, timeoutMs);

    function finish() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }

    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") finish();
    }

    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
      else chrome.tabs.onUpdated.addListener(onUpdated);
    }, reject);
  });
}

async function withTabRetry(fn, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err?.message || String(err);
      if (!/cannot be edited|dragging a tab/i.test(msg)) throw err;
      await sleep(400 + i * 350);
    }
  }
  throw lastErr;
}

/**
 * Open or reuse a site tab. An open tab on the site is used as it is: the
 * scrapers only fetch from its origin, so the user's page is never navigated
 * away. No focus is forced on existing tabs (that triggers "Tabs cannot be
 * edited right now" when the user is switching tabs). New tabs are opened
 * focused so Cloudflare challenges are visible.
 */
async function ensureSiteTab(urlPatterns, openUrl) {
  return enqueueTabOp(() =>
    withTabRetry(async () => {
      // Discarded tabs can't run scripts
      const existing = await chrome.tabs.query({ url: urlPatterns, discarded: false });
      let tab =
        existing.find((t) => t.status === "complete") || existing[0] || null;

      if (!tab) {
        tab = await chrome.tabs.create({ url: openUrl, active: true });
        await waitTabComplete(tab.id);
        await sleep(1200);
        return { tab: await chrome.tabs.get(tab.id), created: true };
      }

      if (tab.status !== "complete") await waitTabComplete(tab.id);
      return { tab: await chrome.tabs.get(tab.id), created: false };
    })
  );
}

/** Run a page-context scraper with the shared title matcher preloaded. */
async function runPageScrape(tabId, func, args, extraFiles = []) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["scrapers/title-match.js", "scrapers/job-filters.js", ...extraFiles],
  });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: [args],
  });
  return result;
}

/**
 * Runs in the Glassdoor page context.
 */
async function glassdoorPageScrape(args) {
  const {
    searchTerm,
    titleQuery,
    resultsWanted,
    fromAge,
    query,
    fallbackToken,
    years,
    jobType,
  } = args;

  const BASE = "https://www.glassdoor.com";
  const JOBS_PER_PAGE = 30;
  const titleOk = (t) =>
    !titleQuery || !globalThis.jbTitleMatches || globalThis.jbTitleMatches(t, titleQuery);
  let scanned = 0;

  if (
    /security\s*\|\s*glassdoor/i.test(document.title) ||
    /attention required|cf-browser-verification/i.test(
      document.body?.innerText || ""
    )
  ) {
    return {
      error:
        "Glassdoor security check is open in a tab. Complete it, then press OK again.",
    };
  }

  async function getToken() {
    try {
      const res = await fetch(`${BASE}/Job/computer-science-jobs.htm`, {
        credentials: "include",
        headers: { accept: "text/html" },
      });
      const html = await res.text();
      if (/security\s*\|\s*glassdoor/i.test(html.slice(0, 2000))) {
        return null;
      }
      const m = html.match(/"token":\s*"([^"]+)"/);
      return m ? m[1] : fallbackToken;
    } catch {
      return fallbackToken;
    }
  }

  const token = (await getToken()) || fallbackToken;
  if (!token) {
    return {
      error:
        "Glassdoor blocked session. Open glassdoor.com, pass the security check, retry.",
    };
  }

  const jobs = [];
  const seen = new Set();
  let cursor = null;
  // Keyword also matches descriptions, so page until enough titles match
  const maxPages = 30;
  const locationId = 11047;
  const locationType = "STATE";

  for (let page = 1; page <= maxPages && jobs.length < resultsWanted; page++) {
    const payload = [
      {
        operationName: "JobSearchResultsQuery",
        variables: {
          excludeJobListingIds: [],
          filterParams: [
            { filterKey: "fromAge", values: String(fromAge) },
            ...(jobType === "fulltime" || jobType === "contract"
              ? [{ filterKey: "jobType", values: jobType }]
              : []),
          ],
          keyword: searchTerm || "",
          numJobsToShow: JOBS_PER_PAGE,
          locationType,
          locationId,
          parameterUrlInput: `IL.0,12_I${locationType}${locationId}`,
          pageNumber: page,
          pageCursor: cursor,
          fromage: fromAge,
          sort: "date",
        },
        query,
      },
    ];

    const res = await fetch(`${BASE}/graph`, {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "*/*",
        "content-type": "application/json",
        "apollographql-client-name": "job-search-next",
        "apollographql-client-version": "4.65.5",
        "gd-csrf-token": token,
      },
      body: JSON.stringify(payload),
    });

    const raw = await res.text();
    if (!res.ok || /security\s*\|\s*glassdoor/i.test(raw.slice(0, 500))) {
      return {
        error: `Glassdoor HTTP ${res.status} (blocked). Complete the security check in the Glassdoor tab, then retry.`,
        rawCount: jobs.length,
        jobs,
      };
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return {
        error: "Glassdoor returned non-JSON",
        jobs,
        rawCount: jobs.length,
      };
    }

    const resJson = Array.isArray(body) ? body[0] : body;
    const listings = resJson?.data?.jobListings?.jobListings || [];
    if (!listings.length) break;

    for (const item of listings) {
      const view = item?.jobview;
      const listingId = view?.job?.listingId;
      if (!listingId) continue;
      const jobUrl = `${BASE}/job-listing/j?jl=${listingId}`;
      if (seen.has(jobUrl)) continue;
      seen.add(jobUrl);
      scanned += 1;

      const titleText =
        view.job?.jobTitleText || view.header?.jobTitleText || "";
      if (!titleOk(titleText)) continue;
      const company = view.header?.employerNameFromSearch || "";
      const location = view.header?.locationName || "Remote";
      const desc = view.job?.description || "";
      // DOMParser documents are inert: no images load, no handlers run
      const parsed = new DOMParser().parseFromString(desc, "text/html");
      const description = (parsed.body?.textContent || "").replace(/\s+/g, " ").trim();
      const kinds = globalThis.jbEmploymentKinds
        ? globalThis.jbEmploymentKinds(description, {
            bareContract: false,
            other: false,
          })
        : [];
      const listingType =
        kinds.includes("fulltime") && kinds.includes("contract")
          ? "Full-time, Contract"
          : kinds.includes("contract")
            ? "Contract"
            : kinds.includes("fulltime")
              ? "Full-time"
              : "";
      const yearsRequired = globalThis.jbRequiredYearsFromText
        ? globalThis.jbRequiredYearsFromText(description)
        : null;
      const ageInDays = view.header?.ageInDays;
      let datePosted = "";
      if (typeof ageInDays === "number") {
        if (ageInDays > fromAge) continue;
        const d = new Date();
        d.setDate(d.getDate() - ageInDays);
        datePosted = d.toISOString().slice(0, 10);
      }

      const job = {
        title: titleText,
        company,
        location,
        site: "glassdoor",
        listing_type: listingType,
        date_posted: datePosted,
        is_remote: "Yes",
        easy_apply: "",
        job_url: jobUrl,
        job_url_direct: "",
        description,
        years_required: yearsRequired == null ? "" : yearsRequired,
      };
      if (
        globalThis.jbWithinExperience &&
        !globalThis.jbWithinExperience(job, years)
      ) {
        continue;
      }
      if (
        globalThis.jbMatchesEmployment &&
        !globalThis.jbMatchesEmployment(job, jobType)
      ) {
        continue;
      }
      jobs.push(job);
      if (jobs.length >= resultsWanted) break;
    }

    const cursors = resJson?.data?.jobListings?.paginationCursors || [];
    const next = cursors.find((c) => c.pageNumber === page + 1);
    cursor = next?.cursor || null;
    if (!cursor) break;
  }

  return { jobs, rawCount: scanned };
}

/**
 * Runs in the ZipRecruiter page context — HTML jobs-search (JobSpy fallback).
 */
async function ziprecruiterPageScrape(args) {
  const { searchTerm, titleQuery, resultsWanted, days, hoursOld, years, jobType } = args;
  // Geo-redirect may land on .ie / .co.uk / etc. — stay on this origin
  const BASE = location.origin;
  const PER_PAGE = 20;
  const titleOk = (t) =>
    !titleQuery || !globalThis.jbTitleMatches || globalThis.jbTitleMatches(t, titleQuery);
  let scanned = 0;
  // ZipRecruiter UI filter only allows 1, 5, 10, 30
  const zrDays = [1, 5, 10, 30].includes(Number(days)) ? Number(days) : 1;

  function parseRelativePosted(text) {
    const s = String(text || "").toLowerCase().replace(/\s+/g, " ");
    const now = Date.now();
    if (/just now|today|minutes? ago|hour(?:s)? ago/.test(s)) {
      return new Date(now).toISOString().slice(0, 10);
    }
    let m = s.match(/(\d+)\s*day(?:s)?\s*ago/);
    if (m) {
      const d = new Date(now - Number(m[1]) * 86400000);
      return d.toISOString().slice(0, 10);
    }
    m = s.match(/(\d+)\s*week(?:s)?\s*ago/);
    if (m) {
      const d = new Date(now - Number(m[1]) * 7 * 86400000);
      return d.toISOString().slice(0, 10);
    }
    m = s.match(/posted\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/);
    if (m) {
      const t = Date.parse(m[1]);
      if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
    }
    return "";
  }

  if (
    /just a moment/i.test(document.title) ||
    /cf-browser-verification|attention required/i.test(
      document.body?.innerText || ""
    )
  ) {
    return {
      error:
        "ZipRecruiter security check is open in a tab. Complete it, then press OK again.",
    };
  }

  const jobs = [];
  const seen = new Set();
  const maxPages = 25;
  const cutoffMs =
    hoursOld && Number(hoursOld) > 0
      ? Date.now() - Number(hoursOld) * 3600 * 1000
      : 0;
  // Card dates are day-only, so compare by UTC day
  const cutoffDay = cutoffMs ? new Date(cutoffMs).toISOString().slice(0, 10) : "";

  for (let page = 1; page <= maxPages && jobs.length < resultsWanted; page++) {
    const params = new URLSearchParams({
      search: searchTerm || "remote",
      location: "United States",
      remote: "1",
      refine_by_location_type: "only_remote",
      days: String(zrDays),
      page: String(page),
    });
    if (jobType === "fulltime") params.set("employment_type", "full_time");
    else if (jobType === "contract") params.set("employment_type", "contract");

    const paths = ["/jobs-search", "/jobs/search"];
    let html = "";
    let blocked = false;
    let lastStatus = 0;
    for (const path of paths) {
      const res = await fetch(`${BASE}${path}?${params}`, {
        credentials: "include",
        headers: { accept: "text/html,application/xhtml+xml" },
        redirect: "follow",
      });
      lastStatus = res.status;
      html = await res.text();
      if (
        /just a moment/i.test(html.slice(0, 4000)) ||
        /cf-browser-verification/i.test(html.slice(0, 4000))
      ) {
        blocked = true;
        break;
      }
      if (res.ok) break;
      html = "";
    }
    if (blocked) {
      return {
        error: `ZipRecruiter HTTP ${lastStatus || 403} (blocked). Complete the security check in the ZipRecruiter tab, then retry.`,
        jobs,
        rawCount: jobs.length,
      };
    }
    if (!html) break;

    const doc = new DOMParser().parseFromString(html, "text/html");
    const articles = [
      ...doc.querySelectorAll('article[id^="job-card-"]'),
    ];
    if (!articles.length) break;

    for (const art of articles) {
      const cardId = art.id || "";
      const listingKey = cardId.includes("job-card-")
        ? cardId.split("job-card-").pop()
        : "";
      if (!listingKey) continue;

      const jobUrl = `${BASE}/jobs//j?lvk=${listingKey}`;
      if (seen.has(jobUrl)) continue;
      seen.add(jobUrl);
      scanned += 1;

      const h = art.querySelector("h1, h2, h3");
      let titleText = h?.textContent?.trim() || "";
      if (!titleText) {
        const img = art.querySelector("img[alt]");
        titleText = (img?.getAttribute("alt") || "").trim();
      }
      if (!titleOk(titleText)) continue;

      const company =
        art
          .querySelector('[data-testid="job-card-company"]')
          ?.textContent?.trim() || "";
      const location =
        art
          .querySelector('[data-testid="job-card-location"]')
          ?.textContent?.trim() || "Remote";

      const cardText = art.textContent || "";
      const timeEl = art.querySelector("time[datetime]");
      let datePosted = timeEl?.getAttribute("datetime") || "";
      if (datePosted && datePosted.length >= 10) {
        datePosted = datePosted.slice(0, 10);
      } else {
        datePosted = parseRelativePosted(cardText);
      }

      if (cutoffDay && /^\d{4}-\d{2}-\d{2}/.test(datePosted)) {
        if (datePosted.slice(0, 10) < cutoffDay) continue;
      }

      const typeMatch = cardText.match(
        /\b(full[\s-]?time|contract(?:or)?|part[\s-]?time|intern(?:ship)?|temporary)\b/i
      );
      const job = {
        title: titleText,
        company,
        location,
        site: "zip_recruiter",
        listing_type: typeMatch ? typeMatch[1] : "",
        date_posted: datePosted,
        is_remote: "Yes",
        easy_apply: "",
        job_url: jobUrl,
        job_url_direct: "",
        description: "",
        years_required: "",
      };
      if (
        globalThis.jbMatchesEmployment &&
        !globalThis.jbMatchesEmployment(job, jobType)
      ) {
        continue;
      }
      if (
        globalThis.jbWithinExperience &&
        !globalThis.jbWithinExperience(job, years)
      ) {
        continue;
      }
      jobs.push(job);
      if (jobs.length >= resultsWanted) break;
    }
  }

  return { jobs, rawCount: scanned };
}

async function runGlassdoorScrape(payload) {
  try {
    const { tab } = await ensureSiteTab(
      ["https://www.glassdoor.com/*"],
      GD_URL
    );
    const result = await runPageScrape(tab.id, glassdoorPageScrape, {
      searchTerm: payload.searchTerm || "",
      titleQuery: payload.title || "",
      resultsWanted: payload.resultsWanted || 50,
      fromAge: payload.fromAge || 3,
      query: GLASSDOOR_QUERY,
      fallbackToken: FALLBACK_CSRF,
      years: payload.years ?? "",
      jobType: payload.jobType || "",
    });

    if (!result) return { error: "Glassdoor scrape returned nothing" };
    if (result.error && !(result.jobs && result.jobs.length)) {
      return { error: result.error };
    }
    return {
      jobs: result.jobs || [],
      rawCount: result.rawCount ?? (result.jobs || []).length,
      error: result.error || null,
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

async function runZipRecruiterScrape(payload) {
  try {
    const search = encodeURIComponent(payload.searchTerm || "remote");
    const days = payload.days || 1;
    const openUrl = `https://www.ziprecruiter.com/jobs-search?search=${search}&location=United+States&remote=1&refine_by_location_type=only_remote&days=${days}`;
    const { tab } = await ensureSiteTab(
      [
        "https://www.ziprecruiter.com/*",
        "https://www.ziprecruiter.ie/*",
        "https://www.ziprecruiter.co.uk/*",
        "https://www.ziprecruiter.ca/*",
      ],
      openUrl
    );
    // Wait for possible geo-redirect (.com → .ie etc.)
    await sleep(800);
    const result = await runPageScrape(tab.id, ziprecruiterPageScrape, {
      searchTerm: payload.searchTerm || "",
      titleQuery: payload.title || "",
      resultsWanted: payload.resultsWanted || 50,
      days: payload.days || 1,
      hoursOld: payload.hoursOld || 24,
      years: payload.years ?? "",
      jobType: payload.jobType || "",
    });

    if (!result) return { error: "ZipRecruiter scrape returned nothing" };
    if (result.error && !(result.jobs && result.jobs.length)) {
      return { error: result.error };
    }
    return {
      jobs: result.jobs || [],
      rawCount: result.rawCount ?? (result.jobs || []).length,
      error: result.error || null,
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

/**
 * Runs in the Jobright page context.
 * Prefers /jobs/search SSR when a keyword is set; falls back to /remote-jobs;
 * paginates swan-api when the user has a session cookie.
 */
async function jobrightPageScrape(args) {
  const { searchTerm, searchUrl, resultsWanted, hoursOld, years, jobType } = args;
  const BASE = "https://jobright.ai";
  const API = "https://swan-api.jobright.ai";

  if (/security check/i.test(document.title)) {
    return {
      error:
        "Jobright security check is open in a tab. Complete it, then press OK again.",
    };
  }

  function toDatePosted(publishTime) {
    if (!publishTime) return "";
    const t = Date.parse(String(publishTime).replace(" ", "T") + "Z");
    if (Number.isNaN(t)) {
      const t2 = Date.parse(String(publishTime));
      if (Number.isNaN(t2)) return String(publishTime).slice(0, 10);
      return new Date(t2).toISOString().slice(0, 10);
    }
    return new Date(t).toISOString().slice(0, 10);
  }

  function normalizeItem(item) {
    const jr = item?.jobResult || item || {};
    const cr = item?.companyResult || {};
    const jobId = jr.jobId || jr.id;
    const title = jr.jobTitle || jr.title || "";
    if (!jobId && !title) return null;

    const isRemote =
      jr.isRemote === true ||
      /remote/i.test(String(jr.workModel || "")) ||
      /remote/i.test(String(jr.jobLocation || ""));

    const locs = Array.isArray(jr.jobLocations)
      ? jr.jobLocations.join(", ")
      : jr.jobLocation || "";

    const requirements = Array.isArray(jr.requirements)
      ? jr.requirements.filter(Boolean).join("\n")
      : "";
    const description = [jr.jobSummary || jr.description || "", requirements]
      .filter(Boolean)
      .join("\n");
    const minYears = jr.minYearsOfExperience;
    const yearsRequired =
      typeof minYears === "number" && Number.isFinite(minYears)
        ? minYears
        : globalThis.jbRequiredYearsFromText
          ? globalThis.jbRequiredYearsFromText(description)
          : "";

    return {
      title,
      company: cr.companyName || jr.companyName || "",
      location: locs || (isRemote ? "Remote" : ""),
      site: "jobright",
      listing_type: jr.employmentType || "",
      date_posted: toDatePosted(jr.publishTime),
      is_remote: isRemote ? "Yes" : "No",
      easy_apply: "",
      job_url: jobId
        ? `${BASE}/jobs/info/${jobId}`
        : jr.jobUrl || jr.url || "",
      job_url_direct: "",
      description,
      years_required: yearsRequired == null ? "" : yearsRequired,
      _isRemote: isRemote,
      _publishMs: jr.publishTime
        ? Date.parse(String(jr.publishTime).replace(" ", "T") + "Z")
        : NaN,
    };
  }

  function parseNextData(html) {
    const m = html.match(
      /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
    );
    if (!m) return [];
    try {
      const data = JSON.parse(m[1]);
      const pp = data?.props?.pageProps || {};
      const list = pp.defaultData || pp.jobList || [];
      if (!Array.isArray(list)) return [];
      return list.map(normalizeItem).filter(Boolean);
    } catch {
      return [];
    }
  }

  async function fetchHtml(pathAndQuery) {
    const res = await fetch(`${BASE}${pathAndQuery}`, {
      credentials: "include",
      headers: { accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    const html = await res.text();
    if (/security check/i.test(html.slice(0, 2000))) {
      return { blocked: true, html, status: res.status };
    }
    return { blocked: false, html, status: res.status };
  }

  const seen = new Set();
  const jobs = [];
  function addAll(rows) {
    for (const j of rows) {
      if (!j) continue;
      const key = j.job_url || `${j.title}|${j.company}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(j);
    }
  }

  const keyword = (searchTerm || "").trim();

  // 1) Keyword search page — same URL format the Jobright UI produces
  if (keyword) {
    const { blocked, html, status } = await fetchHtml(
      searchUrl.replace(BASE, "")
    );
    if (blocked) {
      return {
        error:
          "Jobright security check blocked search. Complete it in the Jobright tab, then retry.",
        jobs,
        rawCount: jobs.length,
      };
    }
    if (status >= 400) {
      // fall through to remote-jobs
    } else {
      addAll(parseNextData(html));
    }
  }

  // 2) Public remote US listings (SSR, no login)
  if (jobs.length < resultsWanted) {
    const { blocked, html, status } = await fetchHtml("/remote-jobs");
    if (blocked && !jobs.length) {
      return {
        error:
          "Jobright security check is open. Complete it in the Jobright tab, then retry.",
        jobs,
        rawCount: 0,
      };
    }
    if (!blocked && status < 400) {
      addAll(parseNextData(html));
    }
  }

  // 3) Authenticated recommendations pagination (if SESSION_ID cookie exists)
  if (jobs.length < resultsWanted) {
    let position = 0;
    const pageSize = 20;
    let empty = 0;
    while (jobs.length < resultsWanted && empty < 2 && position < 200) {
      const params = new URLSearchParams({
        position: String(position),
        count: String(pageSize),
      });
      if (position === 0) params.set("refresh", "true");
      try {
        const res = await fetch(
          `${API}/swan/recommend/list/jobs?${params}`,
          {
            credentials: "include",
            headers: {
              accept: "application/json",
              origin: BASE,
              referer: `${BASE}/`,
            },
          }
        );
        if (res.status === 401 || res.status === 403) break;
        const data = await res.json();
        if (!data?.success) break;
        const list = data?.result?.jobList || [];
        if (!list.length) {
          empty += 1;
          position += pageSize;
          continue;
        }
        empty = 0;
        addAll(list.map(normalizeItem).filter(Boolean));
        position += pageSize;
      } catch {
        break;
      }
    }
  }

  // Keep remote-only; apply posted-date cutoff when publishTime exists
  const cutoff =
    hoursOld && Number(hoursOld) > 0
      ? Date.now() - Number(hoursOld) * 3600 * 1000
      : 0;

  const filtered = jobs.filter((j) => {
    if (j._isRemote === false) return false;
    if (cutoff && j._publishMs && !Number.isNaN(j._publishMs)) {
      if (j._publishMs < cutoff) return false;
    }
    if (globalThis.jbWithinExperience && !globalThis.jbWithinExperience(j, years)) {
      return false;
    }
    if (globalThis.jbMatchesEmployment && !globalThis.jbMatchesEmployment(j, jobType)) {
      return false;
    }
    return true;
  });

  for (const j of filtered) {
    delete j._isRemote;
    delete j._publishMs;
  }

  return { jobs: filtered, rawCount: filtered.length };
}

async function runJobrightScrape(payload) {
  try {
    const keyword = (payload.searchTerm || "").trim();
    const openUrl = keyword
      ? jobrightSearchUrl(keyword, payload.daysAgo || 1)
      : "https://jobright.ai/remote-jobs";
    const { tab } = await ensureSiteTab(
      ["https://jobright.ai/*", "https://www.jobright.ai/*"],
      openUrl
    );
    await sleep(1000);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["scrapers/job-filters.js"],
    });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: jobrightPageScrape,
      args: [
        {
          searchTerm: payload.searchTerm || "",
          searchUrl: openUrl,
          resultsWanted: payload.resultsWanted || 50,
          hoursOld: payload.hoursOld || 24,
          years: payload.years ?? "",
          jobType: payload.jobType || "",
        },
      ],
    });

    if (!result) return { error: "Jobright scrape returned nothing" };
    if (result.error && !(result.jobs && result.jobs.length)) {
      return { error: result.error };
    }
    return {
      jobs: result.jobs || [],
      rawCount: result.rawCount ?? (result.jobs || []).length,
      error: result.error || null,
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

/**
 * Runs in the Dice page context.
 * Parses jobList from Next.js RSC flight scripts on /jobs search pages.
 */
async function dicePageScrape(args) {
  const {
    searchTerm,
    titleQuery,
    resultsWanted,
    hoursOld,
    postedDate = "ONE",
    years,
    jobType,
  } = args;
  const BASE = "https://www.dice.com";
  const PAGE_SIZE = 30;
  const titleOk = (t) =>
    !titleQuery || !globalThis.jbTitleMatches || globalThis.jbTitleMatches(t, titleQuery);
  let scanned = 0;

  if (/just a moment|attention required|security check/i.test(document.title)) {
    return {
      error:
        "Dice security check is open in a tab. Complete it, then press OK again.",
    };
  }

  function extractBalancedObject(text, startIdx) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = startIdx; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(startIdx, j + 1);
      }
    }
    return null;
  }

  function parseJobList(html) {
    const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const tag of scripts) {
      if (!tag.includes("jobList") || !tag.includes("detailsPageUrl")) continue;
      const body = tag.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
      const m = body.match(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/);
      if (!m) continue;
      let decoded;
      try {
        decoded = JSON.parse(`"${m[1]}"`);
      } catch {
        continue;
      }
      const start = decoded.indexOf('{"jobList"');
      if (start < 0) continue;
      const raw = extractBalancedObject(decoded, start);
      if (!raw) continue;
      try {
        const obj = JSON.parse(raw);
        return obj.jobList || null;
      } catch {
        continue;
      }
    }
    return null;
  }

  function toDatePosted(iso) {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return String(iso).slice(0, 10);
    return new Date(t).toISOString().slice(0, 10);
  }

  function normalizeItem(row) {
    if (!row || typeof row !== "object") return null;
    const title = row.title || "";
    const url = row.detailsPageUrl || "";
    if (!title && !url) return null;

    const workplace = Array.isArray(row.workplaceTypes)
      ? row.workplaceTypes.join(", ")
      : "";
    const isRemote =
      row.isRemote === true ||
      /remote/i.test(workplace) ||
      /remote/i.test(String(row.summary || ""));

    const loc =
      row.jobLocation?.displayName ||
      row.jobLocation?.name ||
      (typeof row.jobLocation === "string" ? row.jobLocation : "") ||
      (isRemote ? "Remote" : workplace) ||
      "Remote";

    const postedMs = row.postedDate ? Date.parse(row.postedDate) : NaN;

    return {
      title,
      company: row.companyName || "",
      location: loc,
      site: "dice",
      listing_type: row.employmentType || "",
      date_posted: toDatePosted(row.postedDate),
      is_remote: isRemote ? "Yes" : "No",
      easy_apply: row.easyApply === true ? "Yes" : row.easyApply === false ? "No" : "",
      job_url: url,
      job_url_direct: row.redirectUrl || "",
      description: row.summary || "",
      years_required: globalThis.jbRequiredYearsFromText
        ? globalThis.jbRequiredYearsFromText(row.summary || "") || ""
        : "",
      _isRemote: isRemote,
      _postedMs: postedMs,
    };
  }

  async function fetchSearchPage(page) {
    const params = new URLSearchParams({
      q: (searchTerm || "").trim(),
      location: "Remote",
      countryCode: "US",
      radius: "30",
      radiusUnit: "mi",
      page: String(page),
      pageSize: String(PAGE_SIZE),
      language: "en",
      "filters.workplaceTypes": "Remote",
      "filters.postedDate": postedDate,
    });
    if (jobType === "fulltime") params.set("filters.employmentType", "FULLTIME");
    else if (jobType === "contract") params.set("filters.employmentType", "CONTRACTS");
    const res = await fetch(`${BASE}/jobs?${params}`, {
      credentials: "include",
      headers: { accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    const html = await res.text();
    const head = html.slice(0, 2500).toLowerCase();
    if (
      /just a moment|cf-browser-verification|attention required|access denied/.test(
        head
      )
    ) {
      return { blocked: true, html, status: res.status };
    }
    return { blocked: false, html, status: res.status };
  }

  const seen = new Set();
  const jobs = [];
  let page = 1;
  let pageCount = 20;
  let emptyStreak = 0;
  const cutoff =
    hoursOld && Number(hoursOld) > 0
      ? Date.now() - Number(hoursOld) * 3600 * 1000
      : 0;

  while (jobs.length < resultsWanted && page <= pageCount && emptyStreak < 2) {
    const { blocked, html, status } = await fetchSearchPage(page);
    if (blocked) {
      return {
        error:
          "Dice security check blocked search. Complete it in the Dice tab, then retry.",
        jobs,
        rawCount: jobs.length,
      };
    }
    if (status >= 400) {
      return {
        error: `Dice HTTP ${status}`,
        jobs,
        rawCount: jobs.length,
      };
    }

    const jl = parseJobList(html);
    if (!jl || !Array.isArray(jl.data)) {
      emptyStreak += 1;
      page += 1;
      continue;
    }

    const metaInner = jl.meta?.meta || jl.meta || {};
    if (metaInner.pageCount) {
      pageCount = Math.min(30, Number(metaInner.pageCount) || pageCount);
    }

    let added = 0;
    for (const row of jl.data) {
      const j = normalizeItem(row);
      if (!j) continue;
      const key = j.job_url || `${j.title}|${j.company}`;
      if (seen.has(key)) continue;
      seen.add(key);
      added += 1;
      scanned += 1;
      const tooOld =
        cutoff && !Number.isNaN(j._postedMs) && j._postedMs < cutoff;
      const typeOk =
        !globalThis.jbMatchesEmployment ||
        globalThis.jbMatchesEmployment(j, jobType);
      const yearsOk =
        !globalThis.jbWithinExperience || globalThis.jbWithinExperience(j, years);
      const keep = j._isRemote && !tooOld && titleOk(j.title) && typeOk && yearsOk;
      delete j._isRemote;
      delete j._postedMs;
      if (keep) jobs.push(j);
      if (jobs.length >= resultsWanted) break;
    }

    if (!added) emptyStreak += 1;
    else emptyStreak = 0;
    page += 1;
  }

  return { jobs, rawCount: scanned };
}

async function runDiceScrape(payload) {
  try {
    const q = encodeURIComponent(payload.searchTerm || "");
    const posted = payload.postedDate || "ONE";
    const employment =
      payload.jobType === "contract"
        ? "&filters.employmentType=CONTRACTS"
        : payload.jobType === "fulltime"
          ? "&filters.employmentType=FULLTIME"
          : "";
    const openUrl =
      `https://www.dice.com/jobs?q=${q}&location=Remote&countryCode=US` +
      `&radius=30&radiusUnit=mi&page=1&pageSize=30` +
      `&filters.workplaceTypes=Remote&filters.postedDate=${posted}${employment}&language=en`;
    const { tab } = await ensureSiteTab(
      ["https://www.dice.com/*", "https://dice.com/*"],
      openUrl
    );
    await sleep(1000);
    const result = await runPageScrape(tab.id, dicePageScrape, {
      searchTerm: payload.searchTerm || "",
      titleQuery: payload.title || "",
      resultsWanted: payload.resultsWanted || 50,
      hoursOld: payload.hoursOld || 24,
      postedDate: posted,
      years: payload.years ?? "",
      jobType: payload.jobType || "",
    });

    if (!result) return { error: "Dice scrape returned nothing" };
    if (result.error && !(result.jobs && result.jobs.length)) {
      return { error: result.error };
    }
    return {
      jobs: result.jobs || [],
      rawCount: result.rawCount ?? (result.jobs || []).length,
      error: result.error || null,
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

/** Runs in the Wellfound page context; the logic lives in scrapers/wellfound-page.js. */
async function wellfoundPageScrape(args) {
  return globalThis.jbWellfoundScrape(args);
}

async function runWellfoundScrape(payload) {
  try {
    const { tab } = await ensureSiteTab(["https://wellfound.com/*"], WF_URL);
    const result = await runPageScrape(
      tab.id,
      wellfoundPageScrape,
      {
        title: payload.title || "",
        stack: payload.stack || "",
        resultsWanted: payload.resultsWanted || 50,
        hoursOld: payload.hoursOld || 24,
        years: payload.years ?? "",
        jobType: payload.jobType || "",
      },
      ["scrapers/wellfound-page.js"]
    );

    if (!result) return { error: "Wellfound scrape returned nothing" };
    if (result.error && !(result.jobs && result.jobs.length)) {
      return { error: result.error };
    }
    return {
      jobs: result.jobs || [],
      rawCount: result.rawCount ?? (result.jobs || []).length,
      pages: result.pages ?? 0,
      hitPageLimit: Boolean(result.hitPageLimit),
      stoppedOld: Boolean(result.stoppedOld),
      dropped: result.dropped || null,
      role: result.role || "",
      error: result.error || null,
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GLASSDOOR_SCRAPE") {
    runGlassdoorScrape(message.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message?.type === "ZIPRECRUITER_SCRAPE") {
    runZipRecruiterScrape(message.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message?.type === "JOBRIGHT_SCRAPE") {
    runJobrightScrape(message.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message?.type === "DICE_SCRAPE") {
    runDiceScrape(message.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message?.type === "WELLFOUND_SCRAPE") {
    runWellfoundScrape(message.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  return undefined;
});

chrome.runtime.onInstalled.addListener(() => {
  console.info(
    "JobBridge Fetch ready (Glassdoor / ZipRecruiter / Jobright / Dice / Wellfound use site tabs)."
  );
});
