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
 * A page's companies hang off ROOT_QUERY … seoLandingPageJobSearchResults({args})
 * and each company (StartupResult) links its jobs (highlightedJobListings).
 * A job page is /jobs/<id>-<slug>. liveStartAt is Unix seconds. Listings are
 * not sorted by date, and many are weeks old, so a 24-hour window can rightly
 * come back nearly empty. Past the last page Wellfound serves page 1 again.
 *
 * Needs title-match.js and job-filters.js loaded first.
 */
(function () {
  const BASE = "https://wellfound.com";
  const BLOCKED_MSG =
    "Wellfound security check is open in a tab. Complete it, then press OK again.";
  const RATE_MSG = "Wellfound is limiting requests (HTTP 429). Wait a few minutes, then retry.";
  const FORMAT_MSG = "Wellfound page format changed (no job data found in __NEXT_DATA__)";
  const APP_ROUTER_MSG =
    "Wellfound moved to a new page format (Next.js app router); the scraper needs updating";
  const SEARCH_KEY = "seoLandingPageJobSearchResults";
  // Seniority words aren't part of Wellfound role slugs
  const SENIORITY_RE =
    /\b(?:senior|sr|snr|junior|jr|lead|staff|principal|mid|level|entry|i|ii|iii|iv|\d+)\b/gi;
  const US_STATES =
    "alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|washington,? d\\.?c\\.?";
  const US_PLACE_RE = new RegExp(
    `\\b(?:united states|usa?|u\\.s\\.a?\\.?|north america|americas|worldwide|anywhere|everywhere|global|${US_STATES}|san francisco|bay area|los angeles|seattle|austin|boston|chicago|denver|atlanta|miami|nyc)\\b`,
    "i"
  );
  // "Portland, OR": state codes are matched exactly, so "London, UK" isn't US
  const US_STATE_CODE_RE =
    /,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)$/;
  // remoteConfig.kind values that allow working remotely
  const REMOTE_KINDS = /^(?:REMOTE|REMOTE_ONLY|REMOTE_OPEN|ONSITE_OR_REMOTE)$/;
  const ONSITE_KINDS = /^(?:ONSITE|NO_REMOTE)$/;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function nextData(html) {
    const m = String(html || "").match(
      /<script\b[^>]*\bid=["']?__NEXT_DATA__["']?[^>]*>([\s\S]*?)<\/script>/i
    );
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  }

  function apolloCache(data) {
    const props = data?.props || {};
    const candidates = [
      props.pageProps?.apolloState?.data,
      props.pageProps?.apolloState,
      props.apolloState?.data,
      props.pageProps?.initialApolloState,
    ];
    return candidates.find((c) => c && typeof c === "object" && Object.keys(c).length) || null;
  }

  /** Cloudflare / DataDome challenge pages (not their passive beacons). */
  function isChallenge(text) {
    return /<title>\s*just a moment|cf-browser-verification|_cf_chl_opt|captcha-delivery\.com|var\s+dd\s*=\s*\{\s*['"]rt['"]/i.test(
      String(text || "")
    );
  }

  // {"__ref": "Type:id"}, or the older {type: "id", id: "Type:id"}
  function refKey(v) {
    if (typeof v?.__ref === "string") return v.__ref;
    if (v?.type === "id" && typeof v.id === "string") return v.id;
    return null;
  }
  function deref(cache, v) {
    if (!v || typeof v !== "object") return v ?? null;
    const key = refKey(v);
    return key ? cache[key] || null : v;
  }

  // ["A"], or {type: "json", json: ["A"]} once the client has hydrated
  function names(value) {
    const list = Array.isArray(value) ? value : Array.isArray(value?.json) ? value.json : [];
    return list.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
  }

  /** Arguments of a cache field name: "f({...})" or Apollo 3's "f:{...}". */
  function keyArgs(key) {
    const open = key.search(/[({:]/);
    if (open < 0) return {};
    const json = key.slice(open).replace(/^\(|\)$/g, "").replace(/^:/, "");
    try {
      const args = JSON.parse(json);
      return args && typeof args === "object" ? args : {};
    } catch {
      return {};
    }
  }

  /** First value under any of `names`, anywhere in a (small) args object. */
  function findArg(args, wanted) {
    const queue = [args];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== "object") continue;
      for (const [k, v] of Object.entries(node)) {
        if (wanted.includes(k) && v != null && typeof v !== "object") return v;
        if (v && typeof v === "object") queue.push(v);
      }
    }
    return undefined;
  }

  /**
   * Every search-results field in the cache, with the role and page it was
   * called with. Breadth-first from ROOT_QUERY: it may sit under talent.viewer.
   */
  function searchConnections(cache) {
    const out = [];
    const queue = cache.ROOT_QUERY ? [{ node: cache.ROOT_QUERY, depth: 0 }] : [];
    const seen = new Set();
    while (queue.length) {
      const { node, depth } = queue.shift();
      if (!node || typeof node !== "object" || seen.has(node) || depth > 8) continue;
      seen.add(node);
      for (const [key, value] of Object.entries(node)) {
        if (key.startsWith(SEARCH_KEY)) {
          const args = keyArgs(key);
          const role = findArg(args, ["role", "roleSlug"]);
          const page = findArg(args, ["page"]);
          out.push({
            role: role == null ? undefined : String(role),
            page: page == null ? undefined : Number(page),
            result: deref(cache, value) || {},
          });
          continue;
        }
        const child = deref(cache, value);
        if (child && typeof child === "object") queue.push({ node: child, depth: depth + 1 });
      }
    }
    return out;
  }

  function toJob(cache, key, node, company) {
    const remoteConfig = deref(cache, node.remoteConfig) || {};
    const kind = String(remoteConfig.kind || "").toUpperCase();
    let remote = null;
    if (ONSITE_KINDS.test(kind) && remoteConfig.wfhFlexible !== true) remote = false;
    else if (node.remote === false || node.remote === "false") remote = false;
    else if (node.remote === true || node.remote === "true" || REMOTE_KINDS.test(kind)) remote = true;

    let postedMs = NaN;
    const live = node.liveStartAt;
    if (live != null && live !== "" && Number.isFinite(Number(live)) && Number(live) > 0) {
      const n = Number(live);
      postedMs = n < 1e12 ? n * 1000 : n;
    } else if (typeof live === "string") {
      postedMs = Date.parse(live);
    }
    const yearsMin = Number(node.yearsExperienceMin);
    return {
      id: String(node.id),
      title: String(node.title).trim(),
      company: String(company?.name || "").trim(),
      url: node.slug
        ? `${BASE}/jobs/${node.id}-${node.slug}`
        : company?.slug
          ? `${BASE}/company/${company.slug}/jobs`
          : "",
      remote,
      locations: names(node.locationNames),
      remoteIn: names(node.acceptedRemoteLocationNames),
      jobType: String(node.jobType || "").toLowerCase().replace(/[_\s]+/g, "-"),
      postedMs,
      description: String(node.description || ""),
      // 0 means "not given", not "no experience needed"
      yearsMin: Number.isFinite(yearsMin) && yearsMin > 0 ? yearsMin : null,
    };
  }

  const isJobNode = (key, node) =>
    node &&
    typeof node === "object" &&
    /^(?:JobListingSearchResult|JobListing)$/.test(node.__typename || key.split(":")[0]) &&
    node.id != null &&
    node.title;
  const isCompanyNode = (key, node) =>
    node &&
    typeof node === "object" &&
    /^(?:StartupResult|Startup)$/.test(node.__typename || key.split(":")[0]);

  /** The jobs this page lists: its companies' job links, else every job node. */
  function pageJobs(cache, connection) {
    const jobs = [];
    const seen = new Set();
    const add = (key, node, company) => {
      if (!isJobNode(key || "", node)) return;
      const id = String(node.id);
      if (seen.has(id)) return;
      seen.add(id);
      jobs.push(toJob(cache, key, node, company));
    };
    const startups = Array.isArray(connection?.result?.startups) ? connection.result.startups : null;
    if (startups) {
      for (const ref of startups) {
        const company = deref(cache, ref);
        if (!company) continue;
        for (const field of ["highlightedJobListings", "jobListings"]) {
          if (!Array.isArray(company[field])) continue;
          for (const jobRef of company[field]) add(refKey(jobRef), deref(cache, jobRef), company);
        }
      }
      if (jobs.length) return jobs;
    }
    // Fallback: every job node, linked to its company in reverse
    const companyOf = new Map();
    for (const [key, node] of Object.entries(cache)) {
      if (!isCompanyNode(key, node)) continue;
      for (const field of ["highlightedJobListings", "jobListings"]) {
        if (!Array.isArray(node[field])) continue;
        for (const ref of node[field]) {
          const k = refKey(ref);
          if (k && !companyOf.has(k)) companyOf.set(k, node);
        }
      }
    }
    for (const [key, node] of Object.entries(cache)) {
      if (!isJobNode(key, node)) continue;
      add(key, node, deref(cache, node.startup) || companyOf.get(key));
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

  /** Wellfound roles whose every word is in the title, best first. */
  async function taxonomyRoles(title) {
    let html;
    try {
      const page = await fetchHtml("/browse/remote-tech-jobs");
      if (!page.res.ok) return [];
      html = page.html;
    } catch {
      return [];
    }
    const data = nextData(html);
    if (!data) return [];
    const titleWords = globalThis.jbNormalizeWords(title);
    const titleSet = new Set(titleWords);
    const head = titleWords[titleWords.length - 1];
    const roles = new Map();
    const queue = [data];
    let visited = 0;
    while (queue.length && visited < 50000) {
      const node = queue.pop();
      visited += 1;
      if (!node || typeof node !== "object") continue;
      if (node.__typename === "SeoRoleKeyword" && node.slug && node.displayName) {
        const words = globalThis.jbNormalizeWords(node.displayName);
        // Exact words only: "Java" is not "JavaScript", "C" is not "Rust"
        if (words.length && words.every((w) => titleSet.has(w))) {
          roles.set(String(node.slug), {
            slug: String(node.slug),
            size: words.length,
            headMatch: words[words.length - 1] === head,
          });
        }
        continue;
      }
      for (const v of Object.values(node)) if (v && typeof v === "object") queue.push(v);
    }
    return [...roles.values()]
      .sort(
        (a, b) =>
          b.size - a.size ||
          Number(b.headMatch) - Number(a.headMatch) ||
          a.slug.length - b.slug.length ||
          a.slug.localeCompare(b.slug)
      )
      .map((r) => r.slug);
  }

  async function roleCandidates(title) {
    const bare = title.replace(SENIORITY_RE, " ").replace(/\s+/g, " ").trim();
    const fromList = await taxonomyRoles(title);
    return [...new Set([...fromList.slice(0, 2), slugify(title), slugify(bare)])].filter(Boolean);
  }

  /**
   * One listing page →
   *   {blocked} | {rateLimited} | {notFound} | {netError} | {status} | {formatError} | {end} | {jobs, connection}
   */
  async function listingPage(path, page, role) {
    const want = `${path}${page > 1 ? `?page=${page}` : ""}`;
    let res;
    let html;
    try {
      ({ res, html } = await fetchHtml(want));
    } catch (err) {
      const timeout = /abort|timeout/i.test(`${err?.name} ${err?.message}`);
      return { netError: timeout ? "Wellfound request timed out" : `Wellfound request failed (${err?.message || err})` };
    }
    if (res.status === 404 || res.status === 410) return { notFound: true };
    const data = nextData(html);
    const cache = data && apolloCache(data);
    if (!cache) {
      if (res.status === 403 || isChallenge(html.slice(0, 20000))) return { blocked: true };
      if (res.status === 429) return { rateLimited: true };
      if (!res.ok) return { status: res.status };
      return { formatError: /self\.__next_f\.push/.test(html) ? APP_ROUTER_MSG : FORMAT_MSG };
    }
    if (data.page === "/_error") return { notFound: true };
    const finalUrl = res.url ? new URL(res.url) : null;
    if (finalUrl && finalUrl.pathname !== path) return { notFound: true };
    // Past the last page Wellfound serves page 1 again
    if (page > 1 && finalUrl && finalUrl.searchParams.get("page") !== String(page)) {
      return { end: true };
    }
    const connections = searchConnections(cache);
    const connection =
      connections.find((c) => (c.page ?? 1) === page) || (connections.length === 1 ? connections[0] : null);
    if (connection && connection.page != null && connection.page !== page) return { end: true };
    // A role page that says it is some other role
    if (role && connection?.role != null && connection.role !== role) return { notFound: true };
    return { jobs: pageJobs(cache, connection), connection };
  }

  function usRemote(job) {
    return (
      !job.remoteIn.length ||
      job.remoteIn.some((n) => US_PLACE_RE.test(n) || US_STATE_CODE_RE.test(n))
    );
  }

  function locationText(job) {
    if (job.remoteIn.some((n) => /^united states$/i.test(n))) return "Remote (United States)";
    if (job.remoteIn.length) {
      const shown = job.remoteIn.slice(0, 3).join(", ");
      return `Remote (${shown}${job.remoteIn.length > 3 ? ", …" : ""})`;
    }
    return job.locations.length ? `Remote · ${job.locations.slice(0, 3).join(", ")}` : "Remote";
  }

  function toRow(job) {
    const fromText = globalThis.jbRequiredYearsFromText(job.description);
    const years =
      job.yearsMin == null ? fromText : fromText == null ? job.yearsMin : Math.max(job.yearsMin, fromText);
    return {
      title: job.title,
      company: job.company,
      location: locationText(job),
      site: "wellfound",
      listing_type: job.jobType,
      date_posted: Number.isNaN(job.postedMs) ? "" : new Date(job.postedMs).toISOString().slice(0, 10),
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

    const titleQ = String(title).trim();
    const cutoff = hoursOld > 0 ? Date.now() - hoursOld * 3600 * 1000 : 0;
    const stats = {
      pages: 0,
      notRemote: 0,
      notUs: 0,
      geoUnspecified: 0,
      tooOld: 0,
      undated: 0,
      title: 0,
      filters: 0,
    };
    const jobs = [];
    const finish = (extra) => ({
      jobs,
      rawCount: seen.size,
      role: source.role,
      ...stats,
      dropped: {
        notRemote: stats.notRemote,
        notUs: stats.notUs,
        tooOld: stats.tooOld,
        title: stats.title,
        filters: stats.filters,
      },
      ...extra,
    });
    const seen = new Set();

    // Role page when the title names a Wellfound role; otherwise every remote job
    let source = { path: "/remote", role: "" };
    let first = null;
    for (const role of titleQ ? await roleCandidates(titleQ) : []) {
      const path = `/role/r/${role}`;
      const page = await listingPage(path, 1, role);
      if (page.blocked) return finish({ error: BLOCKED_MSG, blocked: true });
      if (page.rateLimited) return finish({ error: RATE_MSG });
      if (page.jobs?.length) {
        source = { path, role };
        first = page;
        break;
      }
    }

    let stopReason = "";
    for (let n = 1; jobs.length < resultsWanted; n++) {
      if (n > maxPages) {
        stopReason = "page limit";
        break;
      }
      const page = n === 1 && first ? first : await listingPage(source.path, n, source.role);
      const failure = page.blocked
        ? BLOCKED_MSG
        : page.rateLimited
          ? RATE_MSG
          : page.netError || page.formatError || (page.status ? `Wellfound HTTP ${page.status}` : "");
      if (failure) return finish({ error: failure, stopReason: "error", blocked: !!page.blocked });
      if (page.end || page.notFound) break;
      if (n === 1 && !page.jobs.length) return finish({ error: FORMAT_MSG });

      let fresh = 0;
      for (const job of page.jobs) {
        if (seen.has(job.id)) continue;
        seen.add(job.id);
        fresh += 1;
        if (job.remote === false) {
          stats.notRemote += 1;
          continue;
        }
        if (!usRemote(job)) {
          stats.notUs += 1;
          continue;
        }
        if (!job.remoteIn.length) stats.geoUnspecified += 1;
        if (Number.isNaN(job.postedMs)) stats.undated += 1;
        else if (cutoff && job.postedMs < cutoff) {
          stats.tooOld += 1;
          continue;
        }
        if (titleQ && !globalThis.jbTitleMatches(job.title, titleQ)) {
          stats.title += 1;
          continue;
        }
        const row = toRow(job);
        if (
          /co-?founder/.test(job.jobType) ||
          !globalThis.jbStackMatches(row, stack) ||
          !globalThis.jbWithinExperience(row, years) ||
          !globalThis.jbMatchesEmployment(row, jobType)
        ) {
          stats.filters += 1;
          continue;
        }
        jobs.push(row);
        if (jobs.length >= resultsWanted) break;
      }
      // A page of only repeats means Wellfound looped back to page 1
      if (!fresh) break;
      stats.pages = n;
      const pageCount = Number(page.connection?.result?.pageCount);
      if (pageCount && n >= pageCount) break;
      if (pauseMs) await sleep(pauseMs);
    }
    return finish({ stopReason, hitPageLimit: stopReason === "page limit" });
  }

  globalThis.jbWellfoundScrape = jbWellfoundScrape;
  globalThis.jbWellfoundSlugify = slugify;
})();
