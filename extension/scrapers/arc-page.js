/**
 * Arc (arc.dev) — runs inside an arc.dev tab. Arc has no public API or feed and
 * sits behind Cloudflare, so its own US remote-jobs pages are fetched from the
 * tab: /en-us/remote-jobs, then ?page=2… while new jobs keep coming.
 * The pages are Next.js: jobs are read from the __NEXT_DATA__ block. Its field
 * names aren't documented, so any object that looks like a job (a title, a
 * company and an id) counts, and the usual field names are tried for the rest.
 * Without that block, the job links on the page are used.
 *
 * Needs title-match.js and job-filters.js loaded first.
 */
(function () {
  const BASE = "https://arc.dev";
  const LIST_PATH = "/en-us/remote-jobs";
  const BLOCKED_MSG = "Arc security check is open in a tab. Complete it, then press OK again.";
  const FORMAT_MSG = "Arc page format changed (no jobs found in the page data or links)";
  const JOB_LINK_RE = /\/remote-jobs\/(?:details|j)\/(?!redirect\/)[\w-]+/i;
  const US_RE = /^(?:us|usa|u\.s\.a?\.?|united states(?: of america)?)$/i;
  const US_WORDS_RE = /\b(?:united states|usa|north america|americas|anywhere|worldwide|global)\b|\bU\.?S\.?\b/i;

  const isChallenge = (status, html) =>
    status === 403 || /<title>\s*just a moment|cf-browser-verification|challenge-platform/i.test(html.slice(0, 5000));

  const first = (obj, keys) => {
    for (const k of keys) {
      const v = obj?.[k];
      if (v != null && v !== "") return v;
    }
    return undefined;
  };
  const text = (v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
  const names = (v) =>
    (Array.isArray(v) ? v : v == null ? [] : [v])
      .map((x) => (typeof x === "string" ? x : text(first(x, ["name", "label", "title", "code", "value"]))))
      .filter(Boolean);

  function companyName(o) {
    const c = first(o, ["company", "companyInfo", "employer", "organization"]);
    if (typeof c === "string") return c;
    return text(first(c, ["name", "title", "companyName"])) || text(first(o, ["companyName", "employerName"]));
  }

  /** Seconds, milliseconds or a date string → ISO, or "". */
  function toIso(v) {
    if (v == null || v === "") return "";
    const n = Number(v);
    const t = Number.isFinite(n) ? (n > 1e12 ? n : n * 1000) : Date.parse(String(v));
    return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : "";
  }

  function looksLikeJob(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return false;
    const title = text(first(o, ["title", "jobTitle", "position", "positionTitle"]));
    const id = first(o, ["randomKey", "id", "jobId", "slug", "key", "uuid"]);
    return Boolean(title && companyName(o) && id != null);
  }

  function jobUrl(o) {
    const raw = text(first(o, ["url", "jobUrl", "link", "href", "path", "detailsUrl", "permalink"]));
    if (raw) {
      try {
        return new URL(raw, BASE).href;
      } catch {
        /* fall through */
      }
    }
    const slug = text(first(o, ["slug", "randomKey", "key", "id", "jobId"]));
    return slug ? `${BASE}/remote-jobs/details/${slug}` : "";
  }

  function fromRecord(o) {
    const countries = [
      ...names(first(o, ["countries", "allowedCountries", "countryRestrictions", "locationRestrictions", "eligibleCountries"])),
      ...names(first(o, ["locations", "location", "jobLocations"])),
    ];
    const skills = [
      ...names(first(o, ["techStack", "skills", "requiredSkills", "tags"])),
      ...names(first(o, ["categories", "jobRoles", "discipline"])),
    ];
    const salaryMin = first(o, ["salaryMin", "minSalary", "minAnnualSalary"]);
    const salaryMax = first(o, ["salaryMax", "maxSalary", "maxAnnualSalary"]);
    const years = Number(first(o, ["minYearsOfExperience", "yearsOfExperience", "minExperience", "experienceYears"]));
    const html = text(first(o, ["description", "descriptionHtml", "summary", "jobDescription", "excerpt"]));
    const description = [
      html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
      skills.length ? `Tech stack: ${skills.join(", ")}` : "",
      salaryMin || salaryMax ? `Salary: ${salaryMin || "?"}–${salaryMax || "?"}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      title: text(first(o, ["title", "jobTitle", "position", "positionTitle"])).trim(),
      company: companyName(o).trim(),
      countries,
      listing_type: names(first(o, ["jobType", "contractType", "employmentType", "type", "commitment"])).join(", "),
      date_posted: toIso(first(o, ["postedAt", "publishedAt", "datePosted", "postedDate", "createdAt", "updatedAt"])),
      job_url: jobUrl(o),
      job_url_direct: text(first(o, ["applyUrl", "applicationUrl", "externalUrl", "applyLink"])),
      description,
      years_required: Number.isFinite(years) && years > 0 ? years : "",
    };
  }

  /** Every job-like object in the page data. */
  function jobsInNextData(html) {
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      return null;
    }
    const out = [];
    const seen = new Set();
    const walk = (v, depth) => {
      if (!v || typeof v !== "object" || depth > 14) return;
      if (looksLikeJob(v)) {
        const id = String(first(v, ["randomKey", "id", "jobId", "slug", "key", "uuid"]));
        if (!seen.has(id)) {
          seen.add(id);
          out.push(fromRecord(v));
        }
        return;
      }
      for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
    };
    walk(data?.props?.pageProps ?? data, 0);
    return out;
  }

  /** Fallback: the job links on the page, titled by their text. */
  function jobsInLinks(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const out = [];
    const seen = new Set();
    for (const a of doc.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      if (!JOB_LINK_RE.test(href)) continue;
      const url = new URL(href, BASE).href.split("?")[0];
      const title = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (!title || seen.has(url)) continue;
      seen.add(url);
      // The card around the link usually names the company on its own line
      const card = a.closest("article, li, [class*='card' i], [class*='job' i]");
      const lines = (card?.innerText || card?.textContent || "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && l !== title);
      out.push({ title, company: lines[0] || "", countries: [], listing_type: "", date_posted: "", job_url: url, job_url_direct: "", description: "", years_required: "" });
    }
    return out;
  }

  /** "yes" when open to the US, "no" when only other countries are named, "unknown" otherwise. */
  function usStatus(countries) {
    if (!countries.length) return "unknown";
    if (countries.some((c) => US_RE.test(c.trim()) || US_WORDS_RE.test(c))) return "yes";
    return "no";
  }

  globalThis.jbArcScrape = async function arcScrape({
    title = "",
    hoursOld = 24,
    years = "",
    jobType = "",
    resultsWanted = 50,
    maxPages = 5,
    pauseMs = 800,
  } = {}) {
    if (/just a moment/i.test(document.title || "")) return { blocked: true, error: BLOCKED_MSG, jobs: [] };

    const jobs = [];
    const seen = new Set();
    const dropped = { notUs: 0, tooOld: 0, title: 0, filters: 0 };
    let scanned = 0;
    let pages = 0;
    let source = "";
    for (let n = 1; n <= maxPages && jobs.length < resultsWanted; n++) {
      let res;
      let html;
      try {
        res = await fetch(`${BASE}${LIST_PATH}${n > 1 ? `?page=${n}` : ""}`, {
          credentials: "include",
          headers: { accept: "text/html,application/xhtml+xml" },
        });
        html = await res.text();
      } catch (err) {
        if (n === 1) return { error: `Arc request failed (${err?.message || err})`, jobs };
        break;
      }
      if (isChallenge(res.status, html)) {
        return { blocked: true, error: BLOCKED_MSG, jobs, rawCount: scanned, pages, dropped };
      }
      if (!res.ok) {
        if (n === 1) return { error: `Arc HTTP ${res.status}`, jobs };
        break;
      }
      pages = n;
      let rows = jobsInNextData(html);
      if (rows?.length) source ||= "page data";
      else {
        rows = jobsInLinks(html);
        if (rows.length) source ||= "links";
      }
      const fresh = rows.filter((r) => r.job_url && !seen.has(r.job_url));
      if (!fresh.length) {
        if (n === 1) return { error: FORMAT_MSG, jobs };
        break; // past the last page
      }
      for (const r of fresh) {
        seen.add(r.job_url);
        scanned += 1;
        const us = usStatus(r.countries);
        if (us === "no") {
          dropped.notUs += 1;
          continue;
        }
        const job = {
          title: r.title,
          company: r.company,
          location: us === "yes" ? `Remote (${r.countries.slice(0, 3).join(", ")})` : "Remote",
          site: "arc",
          listing_type: r.listing_type,
          date_posted: r.date_posted,
          is_remote: "Yes",
          easy_apply: "",
          job_url: r.job_url,
          job_url_direct: r.job_url_direct,
          description: r.description,
          years_required:
            r.years_required !== "" ? r.years_required : globalThis.jbRequiredYearsFromText(r.description) ?? "",
        };
        if (job.date_posted && hoursOld && Date.parse(job.date_posted) < Date.now() - hoursOld * 3600e3) {
          dropped.tooOld += 1;
          continue;
        }
        if (title && !globalThis.jbTitleMatches(job.title, title)) {
          dropped.title += 1;
          continue;
        }
        if (!globalThis.jbWithinExperience(job, years) || !globalThis.jbMatchesEmployment(job, jobType)) {
          dropped.filters += 1;
          continue;
        }
        jobs.push(job);
        if (jobs.length >= resultsWanted) break;
      }
      if (pauseMs && n < maxPages && jobs.length < resultsWanted) await new Promise((r) => setTimeout(r, pauseMs));
    }
    return { jobs, rawCount: scanned, pages, source, dropped, hitPageLimit: pages >= maxPages };
  };
})();
