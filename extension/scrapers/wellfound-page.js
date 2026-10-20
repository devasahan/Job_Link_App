/**
 * Wellfound scrape that runs inside a wellfound.com tab. Plain script (no
 * import/export) so it can be injected via
 * chrome.scripting.executeScript({ files }); tests load it in Node.
 *
 * Wellfound has no public jobs API (its GraphQL is signed and bot-protected).
 * Its public role pages are server-rendered by Next.js: the listings sit in
 * <script id="__NEXT_DATA__"> at props.pageProps.apolloState.data, a flat
 * Apollo cache keyed "Type:id" with {"__ref": "Type:id"} links.
 *   /role/r/<role>?page=N     remote jobs for one role (about 20 companies a page)
 *   /remote?page=N            remote jobs for every role
 *   /browse/remote-tech-jobs  the role list (SeoRoleKeyword slug + displayName)
 * A job page is /jobs/<id>-<slug>. liveStartAt is Unix seconds.
 * Past the last page Wellfound serves page 1 again. Many listings are weeks
 * old, so a 24-hour window can rightly come back nearly empty.
 *
 * Needs title-match.js and job-filters.js loaded first.
 */
(function () {
  const BASE = "https://wellfound.com";
  const BLOCKED_MSG =
    "Wellfound security check is open in a tab. Complete it, then press OK again.";
  const FORMAT_MSG =
    "Wellfound page format changed (no job data found in __NEXT_DATA__)";
  // Seniority words aren't part of Wellfound role slugs
  const SENIORITY_RE =
    /\b(?:senior|sr|snr|junior|jr|lead|staff|principal|mid|level|entry|i|ii|iii|iv|\d+)\b/gi;
  const US_REMOTE_RE =
    /\b(?:united states|usa?|u\.s\.a?\.?|north america|americas|worldwide|anywhere|global)\b/i;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function nextData(html) {
    const m = String(html || "").match(
      /<script[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
    );
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  }

  function apolloCache(data) {
    const state = data?.props?.pageProps?.apolloState;
    const cache = state?.data || state;
    return cache && typeof cache === "object" ? cache : null;
  }

  /** Cloudflare / DataDome challenge pages (not their passive beacons). */
  function isChallenge(text) {
    return /<title>\s*just a moment|cf-browser-verification|_cf_chl_opt|captcha-delivery\.com|var\s+dd\s*=\s*\{\s*['"]rt['"]/i.test(
      String(text || "")
    );
  }

  // {"__ref": "Type:id"}, or the older {type: "id", id: "Type:id"}
  function deref(cache, v) {
    if (!v || typeof v !== "object") return v;
    if (typeof v.__ref === "string") return cache[v.__ref];
    if (v.type === "id" && typeof v.id === "string" && v.id in cache) return cache[v.id];
    return v;
  }
  const refKey = (v) =>
    typeof v?.__ref === "string" ? v.__ref : v?.type === "id" ? v.id : null;

  // ["A"], or {type: "json", json: ["A"]} once the client has hydrated
  function names(value) {
    const list = Array.isArray(value)
      ? value
      : Array.isArray(value?.json)
        ? value.json
        : [];
    return list.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
  }

  /**
   * The ROOT_QUERY field "seoLandingPageJobSearchResults({...args})" says which
   * role and page Wellfound actually served. Breadth-first: it may be nested.
   */
  function searchMeta(cache) {
    const queue = cache.ROOT_QUERY ? [cache.ROOT_QUERY] : [];
    const seen = new Set();
    while (queue.length && seen.size < 500) {
      const node = queue.shift();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      for (const [key, value] of Object.entries(node)) {
        if (key.startsWith("seoLandingPageJobSearchResults")) {
          let args = {};
          const m = key.match(/\((\{[\s\S]*\})\)\s*$/);
          if (m) {
            try {
              args = JSON.parse(m[1]);
            } catch {
              args = {};
            }
          }
          const result = deref(cache, value) || {};
          return { args, pageCount: Number(result.pageCount) || null };
        }
        const child = deref(cache, value);
        if (child && typeof child === "object") queue.push(child);
      }
    }
    return null;
  }

  function jobsFromCache(cache) {
    // Search results only link jobs from their company (StartupResult)
    const companyOf = new Map();
    for (const node of Object.values(cache)) {
      if (!node || typeof node !== "object" || !node.name) continue;
      for (const field of ["highlightedJobListings", "jobListings"]) {
        if (!Array.isArray(node[field])) continue;
        for (const ref of node[field]) {
          const key = refKey(ref);
          if (typeof key === "string") companyOf.set(key, node);
        }
      }
    }

    const jobs = [];
    for (const [key, node] of Object.entries(cache)) {
      if (!node || typeof node !== "object") continue;
      const type = node.__typename || key.split(":")[0];
      if (type !== "JobListingSearchResult" && type !== "JobListing") continue;
      if (node.id == null || !node.title) continue;
      const company = deref(cache, node.startup) || companyOf.get(key) || {};
      const remoteConfig = deref(cache, node.remoteConfig) || {};
      const live = Number(node.liveStartAt);
      const yearsMin = Number(node.yearsExperienceMin);
      jobs.push({
        id: String(node.id),
        title: String(node.title).trim(),
        company: String(company.name || "").trim(),
        url: node.slug
          ? `${BASE}/jobs/${node.id}-${node.slug}`
          : company.slug
            ? `${BASE}/company/${company.slug}/jobs`
            : "",
        remote:
          node.remote === true ||
          /REMOTE/.test(String(remoteConfig.kind || ""))
            ? true
            : node.remote === false
              ? false
              : null,
        locations: names(node.locationNames),
        remoteIn: names(node.acceptedRemoteLocationNames),
        jobType: String(node.jobType || "").replace(/_/g, "-"),
        // Seconds; tolerate milliseconds
        postedMs: live > 0 ? (live < 1e12 ? live * 1000 : live) : NaN,
        description: String(node.description || ""),
        yearsMin:
          node.yearsExperienceMin != null && Number.isFinite(yearsMin) ? yearsMin : null,
      });
    }
    return jobs;
  }

  /** "Senior Software Engineer!" → "senior-software-engineer" */
  function slugify(text) {
    return String(text || "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  async function fetchHtml(path) {
    const res = await fetch(`${BASE}${path}`, {
      credentials: "include",
      headers: { accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      // A stalled request must not hang the whole run
      signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(20000) : undefined,
    });
    return { res, html: await res.text() };
  }

  /** Best Wellfound role for a title: the longest role name the title contains. */
  async function taxonomyRole(title) {
    try {
      const { res, html } = await fetchHtml("/browse/remote-tech-jobs");
      if (!res.ok) return "";
      const data = nextData(html);
      if (!data) return "";
      let best = "";
      let bestSize = 0;
      const queue = [data];
      let visited = 0;
      while (queue.length && visited < 50000) {
        const node = queue.pop();
        visited += 1;
        if (!node || typeof node !== "object") continue;
        if (node.__typename === "SeoRoleKeyword" && node.slug && node.displayName) {
          const size = globalThis.jbTitleQueryTokens(node.displayName).length;
          if (size > bestSize && globalThis.jbTitleMatches(title, node.displayName)) {
            best = String(node.slug);
            bestSize = size;
          }
          continue;
        }
        for (const v of Object.values(node)) {
          if (v && typeof v === "object") queue.push(v);
        }
      }
      return best;
    } catch {
      return "";
    }
  }

  async function roleCandidates(title) {
    const bare = title.replace(SENIORITY_RE, " ").replace(/\s+/g, " ").trim();
    return [...new Set([await taxonomyRole(title), slugify(title), slugify(bare)])].filter(
      Boolean
    );
  }

  /** One listing page → {blocked} | {status} | {end} | {meta, jobs}. */
  async function listingPage(path, page) {
    const { res, html } = await fetchHtml(`${path}${page > 1 ? `?page=${page}` : ""}`);
    if (res.status === 403 || res.status === 429 || isChallenge(html.slice(0, 20000))) {
      return { blocked: true, status: res.status };
    }
    if (!res.ok) return { status: res.status };
    if (page > 1 && res.url) {
      const served = new URL(res.url).searchParams.get("page");
      if (served !== String(page)) return { end: true };
    }
    const data = nextData(html);
    const cache = data && apolloCache(data);
    if (!cache) return { status: res.status, noData: true };
    const meta = searchMeta(cache);
    if (page > 1 && meta && Number(meta.args.page || 1) !== page) return { end: true };
    return { meta, jobs: jobsFromCache(cache) };
  }

  function usRemote(job) {
    if (job.remote === false) return false;
    if (!job.remoteIn.length) return true;
    return job.remoteIn.some((n) => US_REMOTE_RE.test(n));
  }

  function toRow(job) {
    const yearsText = globalThis.jbRequiredYearsFromText(job.description);
    const years = job.yearsMin != null ? job.yearsMin : yearsText;
    return {
      title: job.title,
      company: job.company,
      location: job.remoteIn.length
        ? `Remote (${job.remoteIn.join(", ")})`
        : job.locations.length
          ? `Remote · ${job.locations.join(", ")}`
          : "Remote",
      site: "wellfound",
      listing_type: job.jobType,
      date_posted: Number.isNaN(job.postedMs)
        ? ""
        : new Date(job.postedMs).toISOString().slice(0, 10),
      is_remote: "Yes",
      easy_apply: "",
      job_url: job.url,
      job_url_direct: "",
      description: job.description,
      years_required: years == null ? "" : years,
    };
  }

  /**
   * @param {{ title?: string, stack?: string, resultsWanted?: number,
   *   hoursOld?: number, years?: number | "", jobType?: string,
   *   maxPages?: number, pauseMs?: number }} args
   */
  async function jbWellfoundScrape(args) {
    const {
      title = "",
      stack = "",
      resultsWanted = 50,
      hoursOld = 24,
      years = "",
      jobType = "",
      // Gentle on Wellfound's bot protection; hitting the cap is reported
      maxPages = 15,
      pauseMs = 600,
    } = args || {};

    if (typeof document !== "undefined") {
      const head = `<title>${document.title}</title>${
        document.documentElement?.innerHTML?.slice(0, 20000) || ""
      }`;
      if (isChallenge(head)) return { error: BLOCKED_MSG };
    }

    const titleQ = String(title).trim();
    const cutoff = hoursOld > 0 ? Date.now() - hoursOld * 3600 * 1000 : 0;

    // Role page when the title names a Wellfound role; otherwise every remote job
    let source = { path: "/remote", role: "" };
    let first = null;
    for (const role of titleQ ? await roleCandidates(titleQ) : []) {
      const page = await listingPage(`/role/r/${role}`, 1);
      if (page.blocked) return { error: BLOCKED_MSG, jobs: [], rawCount: 0 };
      // An unknown role can be served as some other search
      const servedRole = page.meta ? page.meta.args.role : role;
      if (page.jobs?.length && servedRole === role) {
        source = { path: `/role/r/${role}`, role };
        first = page;
        break;
      }
    }

    const jobs = [];
    const seen = new Set();
    const dropped = { notUs: 0, tooOld: 0, title: 0, filters: 0 };
    let scanned = 0;
    let pages = 0;
    let pageCount = null;
    let hitPageLimit = false;
    // Pages in a row with nothing inside the Posted window
    let stalePages = 0;
    let stoppedOld = false;
    for (let n = 1; jobs.length < resultsWanted; n++) {
      if (n > maxPages) {
        hitPageLimit = true;
        break;
      }
      const page = n === 1 && first ? first : await listingPage(source.path, n);
      if (page.blocked) {
        return { error: BLOCKED_MSG, jobs, rawCount: scanned, pages, role: source.role };
      }
      if (page.end) break;
      if (!page.jobs) {
        if (n > 1) break;
        return {
          error: page.noData ? FORMAT_MSG : `Wellfound HTTP ${page.status}`,
          jobs,
          rawCount: scanned,
          pages,
          role: source.role,
        };
      }
      if (n === 1 && !page.jobs.length) {
        return { error: FORMAT_MSG, jobs, rawCount: scanned, pages, role: source.role };
      }
      pages = n;
      if (page.meta?.pageCount) pageCount = page.meta.pageCount;

      let fresh = 0;
      let dated = 0;
      let inWindow = 0;
      for (const job of page.jobs) {
        if (seen.has(job.id)) continue;
        seen.add(job.id);
        fresh += 1;
        scanned += 1;
        if (!Number.isNaN(job.postedMs)) {
          dated += 1;
          if (!cutoff || job.postedMs >= cutoff) inWindow += 1;
        }
        if (!usRemote(job)) {
          dropped.notUs += 1;
          continue;
        }
        if (cutoff && !Number.isNaN(job.postedMs) && job.postedMs < cutoff) {
          dropped.tooOld += 1;
          continue;
        }
        if (titleQ && !globalThis.jbTitleMatches(job.title, titleQ)) {
          dropped.title += 1;
          continue;
        }
        const row = toRow(job);
        if (
          !globalThis.jbStackMatches(row, stack) ||
          !globalThis.jbWithinExperience(row, years) ||
          !globalThis.jbMatchesEmployment(row, jobType)
        ) {
          dropped.filters += 1;
          continue;
        }
        jobs.push(row);
        if (jobs.length >= resultsWanted) break;
      }
      // A page of only repeats means Wellfound looped back to page 1
      if (!fresh) break;
      if (pageCount && n >= pageCount) break;
      // Listings run roughly newest first; three stale pages in a row ends it
      stalePages = cutoff && dated && !inWindow ? stalePages + 1 : 0;
      if (stalePages >= 3) {
        stoppedOld = true;
        break;
      }
      if (pauseMs) await sleep(pauseMs);
    }

    return {
      jobs,
      rawCount: scanned,
      pages,
      pageCount,
      hitPageLimit,
      stoppedOld,
      dropped,
      role: source.role,
    };
  }

  globalThis.jbWellfoundScrape = jbWellfoundScrape;
  globalThis.jbWellfoundSlugify = slugify;
})();
