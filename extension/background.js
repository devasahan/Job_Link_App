/**
 * Background service worker.
 * - Keeps declarativeNetRequest host access alive
 * - Runs Glassdoor / ZipRecruiter / Jobright / Dice / Wellfound scrapes inside real site tabs (avoids CF 403)
 */

import { FALLBACK_CSRF, GLASSDOOR_QUERY } from "./scrapers/glassdoor-query.js";
import { jobrightSearchUrl } from "./scrapers/jobright.js";

const GD_URL = "https://www.glassdoor.com/Job/remote-jobs.htm";
const WF_URL = "https://wellfound.com/remote";
const ZR_ORIGIN_KEY = "zipRecruiterRegionalOrigin";
// A regional site the manifest grants (not www.ziprecruiter.com itself)
const ZR_REGIONAL_RE = /^https:\/\/(?:[a-z0-9-]+\.)?ziprecruiter\.(?:ie|co\.uk|ca)$/;

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

/** Open a new focused site tab, so any Cloudflare / DataDome check is visible. */
async function openSiteTab(openUrl) {
  return enqueueTabOp(() =>
    withTabRetry(async () => {
      const tab = await chrome.tabs.create({ url: openUrl, active: true });
      await waitTabComplete(tab.id);
      await sleep(1200);
      return { tab: await chrome.tabs.get(tab.id), created: true };
    })
  );
}

/**
 * An open site tab to reuse, or null. It is used as it is: the scrapers only
 * fetch from its origin, so the user's page is never navigated away. No
 * focus is forced on existing tabs (that triggers "Tabs cannot be edited
 * right now" when the user is switching tabs). Earlier patterns win.
 */
async function findSiteTab(urlPatterns) {
  for (const url of urlPatterns) {
    // Discarded or unloaded tabs can't run scripts
    const tabs = (await chrome.tabs.query({ url, discarded: false }))
      .filter((t) => t.status !== "unloaded")
      // The tab used last is where the user passed any security check
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const tab = tabs.find((t) => t.status === "complete") || tabs[0];
    if (!tab) continue;
    if (tab.status !== "complete") await waitTabComplete(tab.id, 15000);
    return chrome.tabs.get(tab.id);
  }
  return null;
}

/**
 * Run a page scrape in a site tab. When a reused tab can't run it (error page,
 * crashed, stuck loading) or the scrape reports `blocked` (an expired
 * bot-check cookie makes fetches fail while the page still looks fine),
 * retry once in a new tab, where the site can show its check. The user's own
 * tab is left alone. Other errors (rate limits, HTTP 500) are returned as
 * they are: a new tab wouldn't help. A new tab that fails isn't retried.
 */
async function scrapeInSiteTab(urlPatterns, openUrl, run) {
  let tab = null;
  try {
    tab = await findSiteTab(urlPatterns);
  } catch {
    // Closed or stuck loading: use a new tab
  }
  if (tab) {
    let result;
    try {
      result = await run(tab.id);
    } catch (err) {
      result = { error: err?.message || String(err), tabFailed: true };
    }
    if (!result?.tabFailed && !(result?.blocked && !result.jobs?.length)) return result;
  }
  const fresh = await openSiteTab(openUrl);
  return run(fresh.tab.id);
}

/** The reply shape every site-tab scrape sends back. */
function siteReply(name, result) {
  if (!result) return { error: `${name} scrape returned nothing` };
  const jobs = result.jobs || [];
  if (result.error && !jobs.length) return { error: result.error };
  return {
    ...result,
    jobs,
    rawCount: result.rawCount ?? jobs.length,
    error: result.error || null,
  };
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
      blocked: true,
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
      blocked: true,
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
    if (res.status === 403 || /security\s*\|\s*glassdoor/i.test(raw.slice(0, 500))) {
      return {
        blocked: true,
        error: `Glassdoor HTTP ${res.status}: its security check blocked the search. Complete it in the Glassdoor tab, then retry.`,
        rawCount: jobs.length,
        jobs,
      };
    }
    if (!res.ok) {
      return {
        error:
          res.status === 429
            ? "Glassdoor is limiting requests (HTTP 429). Wait a few minutes, then retry."
            : `Glassdoor HTTP ${res.status}`,
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
      // DOMParser documents are inert: no images load, no handlers run.
      // Space block tags so list items don't run together.
      const parsed = new DOMParser().parseFromString(
        desc.replace(/<\/?(?:p|div|li|ul|ol|br|h[1-6]|tr|td)\b[^>]*>/gi, " $&"),
        "text/html"
      );
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
      blocked: true,
      error:
        "ZipRecruiter security check is open in a tab. Complete it, then press OK again.",
      // Remember a regional landing even when it shows the check first
      origin: BASE,
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
    if (blocked || (!html && lastStatus === 403)) {
      return {
        blocked: true,
        error: `ZipRecruiter HTTP ${lastStatus || 403}: its security check blocked the search. Complete it in the ZipRecruiter tab, then retry.`,
        jobs,
        rawCount: jobs.length,
        origin: BASE,
      };
    }
    if (!html && lastStatus === 429) {
      return {
        error: "ZipRecruiter is limiting requests (HTTP 429). Wait a few minutes, then retry.",
        jobs,
        rawCount: jobs.length,
        origin: BASE,
      };
    }
    // A later page that isn't there is the end; a failing first page or server is an error
    if (!html && lastStatus >= 400 && (page === 1 || lastStatus >= 500)) {
      return { error: `ZipRecruiter HTTP ${lastStatus}`, jobs, rawCount: jobs.length, origin: BASE };
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

  return { jobs, rawCount: scanned, origin: BASE };
}

async function runGlassdoorScrape(payload) {
  try {
    const result = await scrapeInSiteTab(["https://www.glassdoor.com/*"], GD_URL, (tabId) =>
      runPageScrape(tabId, glassdoorPageScrape, {
        searchTerm: payload.searchTerm || "",
        titleQuery: payload.title || "",
        resultsWanted: payload.resultsWanted || 50,
        fromAge: payload.fromAge || 3,
        query: GLASSDOOR_QUERY,
        fallbackToken: FALLBACK_CSRF,
        years: payload.years ?? "",
        jobType: payload.jobType || "",
      })
    );
    return siteReply("Glassdoor", result);
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

async function runZipRecruiterScrape(payload) {
  try {
    const search = encodeURIComponent(payload.searchTerm || "remote");
    const days = payload.days || 1;
    const openUrl = `https://www.ziprecruiter.com/jobs-search?search=${search}&location=United+States&remote=1&refine_by_location_type=only_remote&days=${days}`;
    // Reuse a US-site tab. A geo-redirect sends new tabs to a regional site
    // (.co.uk, .ie, .ca); once a scrape has landed there, reuse tabs on it
    // too, or every run would open another one.
    const patterns = ["https://www.ziprecruiter.com/*"];
    const stored = await chrome.storage.session.get(ZR_ORIGIN_KEY).catch(() => ({}));
    const regional = stored?.[ZR_ORIGIN_KEY];
    if (ZR_REGIONAL_RE.test(regional || "")) patterns.push(`${regional}/*`);
    const result = await scrapeInSiteTab(patterns, openUrl, (tabId) =>
      runPageScrape(tabId, ziprecruiterPageScrape, {
        searchTerm: payload.searchTerm || "",
        titleQuery: payload.title || "",
        resultsWanted: payload.resultsWanted || 50,
        days: payload.days || 1,
        hoursOld: payload.hoursOld || 24,
        years: payload.years ?? "",
        jobType: payload.jobType || "",
      })
    );
    if (ZR_REGIONAL_RE.test(result?.origin || "")) {
      await chrome.storage.session.set({ [ZR_ORIGIN_KEY]: result.origin }).catch(() => {});
    }
    return siteReply("ZipRecruiter", result);
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
      blocked: true,
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

  // Jobs whose original post is on LinkedIn are left out, and counted for the log
  const viaLinkedIn = new Set();
  let anyOutsideLink = false;

  function normalizeItem(item) {
    const record = item?.jobResult || item || {};
    const links = globalThis.jbRecordLinks(record, "jobright.ai");
    anyOutsideLink ||= links.outside;
    if (links.linkedIn) {
      viaLinkedIn.add(record.jobId || record.id || record.jobTitle || record.title);
      return null;
    }
    const jr = record;
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
        blocked: true,
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
        blocked: true,
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

  return { jobs: filtered, rawCount: filtered.length, viaLinkedIn: viaLinkedIn.size, anyOutsideLink };
}

async function runJobrightScrape(payload) {
  try {
    const keyword = (payload.searchTerm || "").trim();
    const openUrl = keyword
      ? jobrightSearchUrl(keyword, payload.daysAgo || 1)
      : "https://jobright.ai/remote-jobs";
    const result = await scrapeInSiteTab(
      ["https://jobright.ai/*", "https://www.jobright.ai/*"],
      openUrl,
      (tabId) =>
        runPageScrape(tabId, jobrightPageScrape, {
          searchTerm: payload.searchTerm || "",
          searchUrl: openUrl,
          resultsWanted: payload.resultsWanted || 50,
          hoursOld: payload.hoursOld || 24,
          years: payload.years ?? "",
          jobType: payload.jobType || "",
        })
    );
    return siteReply("Jobright", result);
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
      blocked: true,
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
    if (blocked || status === 403) {
      return {
        blocked: true,
        error:
          "Dice security check blocked search. Complete it in the Dice tab, then retry.",
        jobs,
        rawCount: jobs.length,
      };
    }
    if (status >= 400) {
      return {
        error:
          status === 429
            ? "Dice is limiting requests (HTTP 429). Wait a few minutes, then retry."
            : `Dice HTTP ${status}`,
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
    const result = await scrapeInSiteTab(
      ["https://www.dice.com/*", "https://dice.com/*"],
      openUrl,
      (tabId) =>
        runPageScrape(tabId, dicePageScrape, {
          searchTerm: payload.searchTerm || "",
          titleQuery: payload.title || "",
          resultsWanted: payload.resultsWanted || 50,
          hoursOld: payload.hoursOld || 24,
          postedDate: posted,
          years: payload.years ?? "",
          jobType: payload.jobType || "",
        })
    );
    return siteReply("Dice", result);
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

/**
 * Runs in the Built In page context. Built In serves its remote job search as
 * server-rendered HTML behind Cloudflare, which refuses fast clients, so pages
 * are fetched one at a time, two seconds apart.
 */
async function builtinPageScrape(args) {
  const {
    searchTerm,
    titleQuery,
    resultsWanted,
    days,
    hoursOld,
    years,
    jobType,
    maxPages = 10,
    pauseMs = 2000,
  } = args;
  const titleOk = (t) => !titleQuery || globalThis.jbTitleMatches(t, titleQuery);
  const US_RE = /\b(?:united states(?: of america)?|usa|us)\b/i;
  const BLOCKED =
    "Built In security check is open in a tab. Complete it, then press OK again.";
  let scanned = 0;

  // "An Hour Ago", "Yesterday", "Reposted 3 Days Ago" → YYYY-MM-DD
  function postedDate(label) {
    const s = String(label || "").toLowerCase().replace("reposted", "").trim();
    const n = Number((s.match(/\d+/) || [1])[0]);
    const unit = /minute/.test(s)
      ? 60e3
      : /hour/.test(s)
        ? 3600e3
        : /yesterday|day/.test(s)
          ? 86400e3
          : /week/.test(s)
            ? 7 * 86400e3
            : /month/.test(s)
              ? 30 * 86400e3
              : 0;
    if (!unit && !/just now|today/.test(s)) return "";
    return new Date(Date.now() - n * unit).toISOString().slice(0, 10);
  }

  // The value next to an icon: <div><i class="fa-…"></i></div> <span>value</span>
  function besideIcon(card, iconClass) {
    const row = card.querySelector(`i.${iconClass}`)?.parentElement?.parentElement;
    return row?.querySelector("span")?.textContent?.replace(/\s+/g, " ").trim() || "";
  }

  async function getPage(page) {
    const params = new URLSearchParams({
      daysSinceUpdated: String(days),
      country: "USA",
      allLocations: "true",
    });
    if (searchTerm) params.set("search", searchTerm);
    if (page > 1) params.set("page", String(page));
    const res = await fetch(`${location.origin}/jobs/remote?${params}`, {
      credentials: "include",
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const cards = [...doc.querySelectorAll('[data-id="job-card"]')];
    const end =
      /no job results/i.test(doc.querySelector("h1")?.textContent || "") ||
      (cards.length > 0 && !doc.querySelector('a[aria-label="Go to Next Page" i]'));
    const challenge = res.status === 403 || /^\s*just a moment/i.test(doc.title);
    return { doc, cards, end, challenge, status: res.status };
  }

  if (/^\s*just a moment/i.test(document.title)) return { blocked: true, error: BLOCKED };

  const jobs = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages && jobs.length < resultsWanted; page++) {
    const { doc, cards, end, challenge, status } = await getPage(page);
    if (challenge) return { blocked: true, error: BLOCKED, jobs, rawCount: scanned };
    if (status === 429 || status === 503) {
      return {
        error: `Built In is limiting requests (HTTP ${status}). Wait a few minutes, then retry.`,
        jobs,
        rawCount: scanned,
      };
    }
    if (!cards.length) {
      if (end || page > 1) break;
      return {
        error: `Built In page format changed (no job cards found, HTTP ${status})`,
        jobs,
        rawCount: scanned,
      };
    }
    for (const card of cards) {
      const link = card.querySelector('a[data-id="job-card-title"]');
      const id = link?.getAttribute("data-builtin-track-job-id") || card.id.replace("job-card-", "");
      if (!link || !id || seen.has(id)) continue;
      seen.add(id);
      scanned += 1;

      const title = link.textContent.replace(/\s+/g, " ").trim();
      if (!/\bremote\b/i.test(besideIcon(card, "fa-house-building"))) continue;
      const place = besideIcon(card, "fa-location-dot");
      // "6 Locations": the list is HTML in the tooltip
      const tip = card.querySelector("[data-bs-title]")?.getAttribute("data-bs-title") || "";
      const places = tip
        ? [...new DOMParser().parseFromString(tip, "text/html").querySelectorAll("div")].map((d) =>
            d.textContent.trim()
          )
        : [];
      const where = places.length ? places : place ? [place] : [];
      if (where.length && !where.some((p) => US_RE.test(p))) continue;
      if (!titleOk(title)) continue;

      const drop = doc.getElementById(`drop-data-${id}`);
      const summary = drop?.querySelector("div.fs-sm.fw-regular")?.textContent?.trim() || "";
      const skills = [...(drop?.querySelectorAll("span.mx-sm") || [])].map((s) => s.textContent.trim());
      const description = [summary, skills.length ? `Top skills: ${skills.join(", ")}` : ""]
        .filter(Boolean)
        .join("\n");
      const job = {
        title,
        company: card.querySelector('a[data-id="company-title"]')?.textContent?.trim() || "",
        location: where.length > 3 ? `${where.slice(0, 3).join("; ")}; …` : where.join("; ") || "Remote",
        site: "builtin",
        listing_type: "",
        date_posted: postedDate(card.querySelector("i.fa-clock")?.parentElement?.textContent),
        is_remote: "Yes",
        easy_apply: card.querySelector("i.fa-bolt") ? "Yes" : "No",
        job_url: new URL(link.getAttribute("href"), "https://builtin.com").href,
        job_url_direct: "",
        description,
        years_required: globalThis.jbRequiredYearsFromText(description) ?? "",
      };
      if (job.date_posted && hoursOld) {
        const cutoffDay = new Date(Date.now() - hoursOld * 3600e3).toISOString().slice(0, 10);
        if (job.date_posted < cutoffDay) continue;
      }
      if (!globalThis.jbWithinExperience(job, years)) continue;
      if (!globalThis.jbMatchesEmployment(job, jobType)) continue;
      jobs.push(job);
      if (jobs.length >= resultsWanted) break;
    }
    if (end) break;
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return { jobs, rawCount: scanned };
}

async function runBuiltinScrape(payload) {
  try {
    const params = new URLSearchParams({
      daysSinceUpdated: String(payload.days || 1),
      country: "USA",
      allLocations: "true",
    });
    if (payload.searchTerm) params.set("search", payload.searchTerm);
    const openUrl = `https://builtin.com/jobs/remote?${params}`;
    const result = await scrapeInSiteTab(["https://builtin.com/*"], openUrl, (tabId) =>
      runPageScrape(tabId, builtinPageScrape, {
        searchTerm: payload.searchTerm || "",
        titleQuery: payload.title || "",
        resultsWanted: payload.resultsWanted || 50,
        days: payload.days || 1,
        hoursOld: payload.hoursOld || 24,
        years: payload.years ?? "",
        jobType: payload.jobType || "",
      })
    );
    return siteReply("Built In", result);
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

/**
 * Runs in a www.workatastartup.com tab. The board's search is Algolia; the
 * site puts a per-session search key in its /companies page. Signed in, the
 * key sees every job; signed out it finds nothing, so that is reported.
 */
async function workatastartupPageScrape(args) {
  const { title, stack, resultsWanted, hoursOld, years, jobType, maxPages = 3 } = args;
  const SIGN_IN =
    "Work at a Startup needs you signed in: sign in at workatastartup.com (free YC account), then press OK again.";
  const INDEX = "WaaSPublicCompanyJob_created_at_desc_production";
  const ATTRS = [
    "title", "description", "created_at", "search_path", "locations_for_search",
    "remote", "job_type", "skills", "min_experience", "company_name",
  ];

  const page = await fetch("/companies", {
    credentials: "include",
    // Without an HTML Accept the site answers 406
    headers: { accept: "text/html,application/xhtml+xml" },
  });
  const html = await page.text();
  let opts = null;
  const m = html.match(/window\.AlgoliaOpts\s*=\s*(\{[\s\S]*?\});/);
  try {
    opts = m ? JSON.parse(m[1]) : null;
  } catch {
    opts = null;
  }
  if (!opts?.app || !opts?.key) return { error: SIGN_IN };
  // An Algolia secured key is base64(64 hex chars of HMAC + its query params).
  // Signed in, the params allow tagFilters jobs_applicant until validUntil.
  let keyParams = null;
  try {
    keyParams = new URLSearchParams(atob(opts.key).slice(64));
  } catch {
    keyParams = null;
  }
  const tags = `${keyParams?.get("tagFilters") || ""} ${JSON.stringify(opts.tag_filters ?? "")}`;
  const validUntil = Number(keyParams?.get("validUntil"));
  if (!tags.includes("jobs_applicant")) return { error: SIGN_IN };
  if (validUntil && validUntil * 1000 < Date.now()) {
    return { error: "Work at a Startup sign-in expired: reload workatastartup.com, then press OK again." };
  }

  const url =
    `https://${String(opts.app).toLowerCase()}-dsn.algolia.net/1/indexes/*/queries` +
    `?x-algolia-application-id=${encodeURIComponent(opts.app)}&x-algolia-api-key=${encodeURIComponent(opts.key)}`;
  const filters = ["(remote:yes OR remote:only)"];
  if (jobType === "fulltime") filters.push('job_type:"fulltime"');
  const cutoff = hoursOld > 0 ? Date.now() - hoursOld * 3600e3 : 0;
  const qs = (o) =>
    Object.entries(o)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");

  // ["US", "CA, US", "San Francisco, CA, US"]; some records hold nested junk
  const countryOf = (place) => {
    if (/^[A-Z]{2}$/.test(place)) return place;
    const last = place.split(",").pop().trim();
    return /^[A-Z]{2}$/.test(last) ? last : "";
  };

  const jobs = [];
  let scanned = 0;
  for (let n = 0; n < maxPages && jobs.length < resultsWanted; n++) {
    const res = await fetch(url, {
      method: "POST",
      // A "simple" request: no CORS preflight
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: JSON.stringify({
        requests: [
          {
            indexName: INDEX,
            params: qs({
              query: title || "",
              filters: filters.join(" AND "),
              hitsPerPage: "100",
              page: String(n),
              distinct: "false",
              attributesToRetrieve: JSON.stringify(ATTRS),
            }),
          },
        ],
      }),
    });
    if (res.status === 403 || res.status === 401) {
      return { error: "Work at a Startup search key expired: reload workatastartup.com, then press OK again.", jobs, rawCount: scanned };
    }
    if (!res.ok) return { error: `Work at a Startup search HTTP ${res.status}`, jobs, rawCount: scanned };
    const result = (await res.json())?.results?.[0] || {};
    const hits = Array.isArray(result.hits) ? result.hits : [];
    if (!hits.length) break;

    let inWindow = 0;
    for (const hit of hits) {
      scanned += 1;
      const created = Date.parse(hit.created_at || "");
      if (!Number.isNaN(created) && (!cutoff || created >= cutoff)) inWindow += 1;
      if (cutoff && !Number.isNaN(created) && created < cutoff) continue;
      if (!/^(?:yes|only)$/i.test(String(hit.remote || ""))) continue;
      const places = [...new Set((hit.locations_for_search || []).filter((p) => typeof p === "string"))];
      const countries = places.map(countryOf).filter(Boolean);
      if (countries.length && !countries.includes("US")) continue;
      const jobTitle = String(hit.title || "").trim();
      if (title && !globalThis.jbTitleMatches(jobTitle, title)) continue;
      const skills = Array.isArray(hit.skills) ? hit.skills.join(", ") : "";
      const description = [String(hit.description || ""), skills && `Skills: ${skills}`].filter(Boolean).join("\n");
      const minYears = Number(hit.min_experience);
      const job = {
        title: jobTitle,
        company: String(hit.company_name || "").trim(),
        location: (() => {
          const named = places.filter((p) => !/^remote$/i.test(p));
          return named.length ? `Remote (${named.slice(0, 3).join("; ")})` : "Remote";
        })(),
        site: "workatastartup",
        listing_type: String(hit.job_type || ""),
        date_posted: Number.isNaN(created) ? "" : new Date(created).toISOString().slice(0, 10),
        is_remote: "Yes",
        easy_apply: "",
        job_url: `https://www.workatastartup.com/jobs/${hit.objectID ?? hit.id}`,
        job_url_direct: hit.search_path || "",
        description,
        years_required:
          Number.isFinite(minYears) && minYears > 0
            ? minYears
            : globalThis.jbRequiredYearsFromText(description) ?? "",
      };
      if (!globalThis.jbStackMatches(job, stack)) continue;
      if (!globalThis.jbWithinExperience(job, years)) continue;
      if (!globalThis.jbMatchesEmployment(job, jobType)) continue;
      jobs.push(job);
      if (jobs.length >= resultsWanted) break;
    }
    // Newest first: a page with nothing inside the window ends it
    if (!inWindow || n + 1 >= Number(result.nbPages || 0)) break;
  }
  return { jobs, rawCount: scanned };
}

async function runWorkAtAStartupScrape(payload) {
  try {
    const result = await scrapeInSiteTab(
      ["https://www.workatastartup.com/*"],
      "https://www.workatastartup.com/companies",
      (tabId) =>
        runPageScrape(tabId, workatastartupPageScrape, {
          title: payload.title || "",
          stack: payload.stack || "",
          resultsWanted: payload.resultsWanted || 50,
          hoursOld: payload.hoursOld || 24,
          years: payload.years ?? "",
          jobType: payload.jobType || "",
        })
    );
    return siteReply("Work at a Startup", result);
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

/** Runs in a work.turing.com tab: the board's own API call, same-origin. */
async function turingPageScrape(args) {
  const res = await fetch("/api/jobs/all", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(args.body),
  });
  const raw = await res.text();
  if (res.status === 403 || /incapsula/i.test(raw.slice(0, 3000))) {
    return { blocked: true, error: "Turing security check is open in a tab. Complete it, then press OK again." };
  }
  if (res.status === 429 || res.status === 503) {
    return { error: `Turing is limiting requests (HTTP ${res.status}). Wait a few minutes, then retry.` };
  }
  try {
    return { status: res.status, data: JSON.parse(raw) };
  } catch {
    return { error: `Turing returned non-JSON (HTTP ${res.status})` };
  }
}

async function runTuringScrape(payload) {
  try {
    return await scrapeInSiteTab(["https://work.turing.com/*"], "https://work.turing.com/jobs", (tabId) =>
      runPageScrape(tabId, turingPageScrape, { body: payload.body })
    );
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
    const result = await scrapeInSiteTab(["https://wellfound.com/*"], WF_URL, (tabId) =>
      runPageScrape(
        tabId,
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
      )
    );
    return siteReply("Wellfound", result);
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
  if (message?.type === "BUILTIN_SCRAPE") {
    runBuiltinScrape(message.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message?.type === "WORKATASTARTUP_SCRAPE") {
    runWorkAtAStartupScrape(message.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message?.type === "TURING_SCRAPE") {
    runTuringScrape(message.payload || {})
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
