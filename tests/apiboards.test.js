import { test } from "node:test";
import assert from "node:assert/strict";

import { scrapeJobs } from "../extension/scrapers/index.js";

// Like a browser: textContent joins text nodes with nothing in between
globalThis.DOMParser = class {
  parseFromString(html) {
    return { body: { textContent: String(html).replace(/<[^>]*>/g, "") } };
  }
};

const nowIso = (hoursAgo = 1) => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
const nowS = (hoursAgo = 1) => Math.floor((Date.now() - hoursAgo * 3600 * 1000) / 1000);

/** Fake fetch: handler(url, init) → {status?, body (object or string)}. */
function fakeFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    const r = await handler(new URL(url), init);
    const status = r.status || 200;
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return { ok: status < 400, status, text: async () => body };
  };
  return calls;
}

// ---- Jobicy (shape of a real 2026-10-20 response, apiVersion 2.2.19) ----
const jobicyRow = (id, extra = {}) => ({
  companyLogo: false,
  companyName: `Jobicy Co ${id}`,
  id,
  jobDescription: "<h3>About</h3><p>We use React and TypeScript.</p><ul><li>3+ years of experience</li></ul>",
  jobExcerpt: "About&hellip;",
  jobGeo: "USA",
  jobIndustry: ["Software Engineering"],
  jobLevel: "Senior",
  jobSlug: `${id}-software-engineer`,
  jobTitle: "Software Engineer",
  jobType: ["Full-Time"],
  pubDate: nowIso(),
  url: `https://jobicy.com/jobs/${id}-software-engineer`,
  ...extra,
});

test("Jobicy: US + Anywhere geos, documented params only, filters and links", async () => {
  const calls = fakeFetch((url) => {
    const geo = url.searchParams.get("geo");
    const jobs =
      geo === "usa"
        ? [
            jobicyRow(1),
            jobicyRow(2, { jobGeo: "Canada,  UK,  USA" }),
            jobicyRow(3, { jobGeo: "APAC,  EMEA" }),
            jobicyRow(4, { jobTitle: "Product Designer" }),
            jobicyRow(5, { jobType: ["Contract"] }),
          ]
        : [jobicyRow(6, { jobGeo: "Anywhere" }), jobicyRow(1)];
    return { body: { success: true, jobs, nextCursor: null, hasMore: false } };
  });
  const { jobs, errors } = await scrapeJobs({
    sites: ["jobicy"],
    title: "Software Engineer",
    stack: "React",
    count: 10,
    datePreset: "today",
    years: 3,
    jobType: "fulltime",
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(jobs.map((j) => j.job_url.split("/").pop()), [
    "1-software-engineer",
    "2-software-engineer",
    "6-software-engineer",
  ]);
  assert.equal(jobs[0].site, "jobicy");
  assert.equal(jobs[0].location, "Remote (USA)");
  assert.equal(jobs[1].location, "Remote (Canada, UK, USA)");
  assert.equal(jobs[0].years_required, 3);
  assert.match(jobs[0].date_posted, /^\d{4}-\d{2}-\d{2}$/);
  for (const c of calls) {
    const u = new URL(c);
    assert.equal(u.pathname, "/api/jobs");
    // No tag: Jobicy's raw substring search knows none of the title synonyms
    assert.deepEqual([...u.searchParams.keys()].sort(), ["count", "geo"]);
    assert.equal(u.searchParams.get("count"), "200");
  }
});

test("Jobicy: falls back to the older API path, follows cursors, stops at old rows", async () => {
  const calls = fakeFetch((url) => {
    if (url.pathname === "/api/jobs") return { status: 404, body: "<html>Not found</html>" };
    const cursor = url.searchParams.get("cursor");
    if (url.searchParams.get("geo") === "anywhere") return { body: { success: true, jobs: [] } };
    if (!cursor) {
      return { body: { success: true, jobs: [jobicyRow(10)], nextCursor: "abc", hasMore: true } };
    }
    return {
      body: {
        success: true,
        jobs: [jobicyRow(11), jobicyRow(12, { pubDate: nowIso(48) })],
        nextCursor: "def",
        hasMore: true,
      },
    };
  });
  const { jobs } = await scrapeJobs({ sites: ["jobicy"], title: "Software Engineer", count: 10, datePreset: "today" });
  assert.deepEqual(jobs.map((j) => j.company), ["Jobicy Co 10", "Jobicy Co 11"]);
  const legacy = calls.filter((c) => c.includes("/api/v2/remote-jobs"));
  assert.ok(legacy.some((c) => new URL(c).searchParams.get("cursor") === "abc"));
  assert.ok(!legacy.some((c) => new URL(c).searchParams.get("cursor") === "def"), "older row ends paging");
});

test("Jobicy: an API error with nothing found fails the board with its message", async () => {
  fakeFetch(() => ({ status: 400, body: { success: false, error: "Unknown parameter: type" } }));
  const { errors } = await scrapeJobs({ sites: ["jobicy"], title: "Software Engineer", count: 5 });
  assert.match(errors[0], /jobicy: Jobicy: Unknown parameter: type/);
});

// ---- Himalayas (shape of a real /jobs/api/search response) ----
const himRow = (n, extra = {}) => ({
  title: "Software Engineer",
  excerpt: "Build things",
  companyName: `Him Co ${n}`,
  companySlug: `him-co-${n}`,
  employmentType: "Full Time",
  seniority: ["Senior"],
  locationRestrictions: ["United States"],
  timezoneRestrictions: [-8, -7, -6, -5],
  categories: ["React-Native-Developer", "Software-Engineer"],
  parentCategories: ["Developer"],
  description: "<div><p>Our stack</p><ul><li>TypeScript</li><li>4+ years of experience</li></ul></div>",
  pubDate: nowS(),
  applicationLink: `https://himalayas.app/companies/him-co-${n}/jobs/software-engineer-${n}`,
  guid: `https://himalayas.app/companies/him-co-${n}/jobs/software-engineer-${n}`,
  ...extra,
});

test("Himalayas: title-only search, US or worldwide, categories feed the stack", async () => {
  const calls = fakeFetch((url) => {
    const page = Number(url.searchParams.get("page"));
    const jobs =
      page === 1
        ? [
            himRow(1),
            himRow(2, { locationRestrictions: [] }),
            himRow(3, { locationRestrictions: ["Germany"] }),
            himRow(4, { locationRestrictions: [{ alpha2: "US", name: "United States" }], pubDate: nowS() * 1000 }),
            himRow(5, { companyName: "name", categories: [] }),
          ]
        : [];
    return { body: { totalCount: 5, jobs } };
  });
  const { jobs, errors } = await scrapeJobs({
    sites: ["himalayas"],
    title: "Software Engineer",
    stack: "React Native",
    count: 10,
    datePreset: "today",
    jobType: "fulltime",
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(jobs.map((j) => j.company), ["Him Co 1", "Him Co 2", "Him Co 4"]);
  assert.equal(jobs[1].location, "Remote (Worldwide)");
  assert.equal(jobs[0].job_url, "https://himalayas.app/companies/him-co-1/jobs/software-engineer-1");
  assert.equal(jobs[0].job_url_direct, "", "the Himalayas page isn't a direct link");
  assert.equal(jobs[0].years_required, 4);
  const u = new URL(calls[0]);
  assert.equal(u.searchParams.get("q"), "Software Engineer");
  assert.equal(u.searchParams.get("country"), "US");
  assert.equal(u.searchParams.get("sort"), "recent");
  assert.equal(u.searchParams.get("employment_type"), "Full Time");
  assert.equal(calls.length, 1, "page 1 covers totalCount");
});

test("Himalayas: raw control characters don't break parsing; a 429 later keeps earlier jobs", async () => {
  let n = 0;
  fakeFetch(() => {
    n += 1;
    if (n === 1) {
      const body = JSON.stringify({ totalCount: 100, jobs: [himRow(1, { excerpt: "PLACEHOLDER" })] });
      return { body: body.replace("PLACEHOLDER", "line1\u0001\u0002line2\ttab") };
    }
    return { status: 429, body: { error: "Rate limit exceeded. Wait 60 seconds before retrying." } };
  });
  const progress = [];
  const { jobs, errors } = await scrapeJobs({
    sites: ["himalayas"],
    title: "Software Engineer",
    count: 10,
    datePreset: "today",
    onProgress: (m) => progress.push(m),
  });
  assert.deepEqual(errors, []);
  assert.equal(jobs.length, 1);
  assert.ok(progress.some((m) => /Himalayas stopped early/.test(m)));
});

test("Himalayas: a page that is entirely too old ends paging", async () => {
  const calls = fakeFetch((url) => {
    const page = Number(url.searchParams.get("page"));
    return { body: { totalCount: 200, jobs: [himRow(page * 10, { pubDate: nowS(page === 1 ? 1 : 100) })] } };
  });
  await scrapeJobs({ sites: ["himalayas"], title: "Software Engineer", count: 10, datePreset: "today" });
  assert.equal(calls.length, 2);
});

test("JSON job text that says 'access denied' isn't mistaken for a block page", async () => {
  fakeFetch(() => ({
    body: { totalCount: 1, jobs: [himRow(1, { excerpt: "Attention required: handle access denied errors" })] },
  }));
  const { jobs, errors } = await scrapeJobs({ sites: ["himalayas"], title: "Software Engineer", count: 5 });
  assert.deepEqual(errors, []);
  assert.equal(jobs.length, 1);
});

// ---- Hacker News: Who is hiring? (headers from real 2026 threads) ----
const THREAD = "49922569";
const comment = (id, html, hoursAgo = 2, parent = THREAD) => ({
  objectID: String(id),
  author: `user${id}`,
  comment_text: html,
  created_at_i: Math.floor(Date.now() / 1000) - hoursAgo * 3600,
  parent_id: Number(parent),
  story_id: Number(THREAD),
});

function fakeHn(comments, { threadAgeDays = 19, previous = null } = {}) {
  return fakeFetch((url) => {
    const tags = url.searchParams.get("tags");
    if (tags === "story,author_whoishiring") {
      const now = Math.floor(Date.now() / 1000);
      const hits = [
        { objectID: "49922568", title: "Ask HN: Who wants to be hired? (October 2026)", created_at_i: now - threadAgeDays * 86400 },
        { objectID: THREAD, title: "Ask HN: Who is hiring? (October 2026)", created_at_i: now - threadAgeDays * 86400 },
      ];
      if (previous) hits.push({ objectID: previous, title: "Ask HN: Who is hiring? (September 2026)", created_at_i: now - 40 * 86400 });
      return { body: { hits } };
    }
    const after = Number(url.searchParams.get("numericFilters").split(">")[1]);
    return { body: { hits: comments.filter((c) => c.created_at_i > after), nbPages: 1 } };
  });
}

test("Hacker News: header-only US-remote decisions on real header shapes", async () => {
  const calls = fakeHn([
    comment(1, 'Felt Clinic (<a href="https:&#x2F;&#x2F;feltclinic.com" rel="nofollow">https:&#x2F;&#x2F;feltclinic.com</a>) | Web Engineer | Remote (US Only) | Full-time | $180k-$200k<p>We build with React. <a href="https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;felt" rel="nofollow">apply</a>'),
    comment(2, "focal vc | Software Engineer | Remote/Onsite/Hybrid (US)<p>React and Python."),
    comment(3, "Euro Co | Software Engineer | REMOTE (EU, Switzerland, Norway)<p>React, global team."),
    comment(4, "NetBird | Berlin, Germany | ONSITE & Remote for some roles<p>We are a global company. Software Engineer, React."),
    comment(5, "Quill | Fullstack SWE | Full-time | Remote, PT&#x2F;ET hours preferred | $150 - 210K USD<p>React."),
    comment(6, "Weave Bio | Full time | https:&#x2F;&#x2F;weave.bio<p>Remote within the US.<p>- Senior Backend Engineer (React, Python)<p>- Product Designer"),
    comment(7, "Cybersecurity graduate seeking SOC Analyst roles. Remote."),
    comment(8, "Plain Co | Software Engineer | REMOTE<p>React. Must be authorized to work in the United States."),
    comment(9, "Mystery Co | Software Engineer | REMOTE<p>React."),
    comment(10, "Reply that is not top-level | Software Engineer | REMOTE (US)<p>React", 2, "999"),
    comment(11, "Old Co | Software Engineer | REMOTE (US)<p>React", 40),
  ]);
  const progress = [];
  const { jobs, errors } = await scrapeJobs({
    sites: ["hackernews"],
    title: "Engineer",
    stack: "React",
    count: 20,
    datePreset: "today",
    onProgress: (m) => progress.push(m),
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    jobs.map((j) => [j.company, j.title, j.location]),
    [
      ["Felt Clinic", "Web Engineer", "Remote (US Only)"],
      ["focal vc", "Software Engineer", "Remote/Onsite/Hybrid (US)"],
      ["Quill", "Fullstack SWE", "Remote, PT/ET hours preferred"],
      // "Multiple roles" style: the role comes from a body line
      ["Weave Bio", "Senior Backend Engineer (React, Python)", "Remote"],
      // Bare REMOTE, US work authorization in the body
      ["Plain Co", "Software Engineer", "REMOTE"],
      ["Mystery Co", "Software Engineer", "Remote (region unspecified)"],
    ]
  );
  assert.equal(jobs[0].job_url, "https://news.ycombinator.com/item?id=1");
  assert.equal(jobs[0].job_url_direct, "https://jobs.ashbyhq.com/felt", "an ATS link beats the homepage");
  assert.ok(progress.some((m) => /not US-remote/.test(m) && /not a job post/.test(m)));
  const window = new URL(calls[1]).searchParams;
  assert.equal(window.get("tags"), `comment,story_${THREAD}`);
  assert.match(window.get("numericFilters"), /^created_at_i>\d+$/);
});
// ---- Jobspresso RSS (shape of the real https://jobspresso.co/jobs/feed/, Oct 2026) ----
const rssItem = (n, { title = "Senior Software Engineer", where = "United States", hoursAgo = 2, body = "<p>React and Node.</p><ul><li>5+ years of experience</li></ul>" } = {}) => `
<item>
  <title>${title}</title>
  <link>https://jobspresso.co/job/job-${n}/</link>
  <dc:creator><![CDATA[Company ${n}<br>⚲&nbsp;${where}]]></dc:creator>
  <pubDate>${new Date(Date.now() - hoursAgo * 3600e3).toUTCString().replace("GMT", "+0000")}</pubDate>
  <guid isPermaLink="false">https://jobspresso.co/?post_type=job_listing&#038;p=16${n}</guid>
  <description><![CDATA[<p>Excerpt</p>]]></description>
  <content:encoded><![CDATA[${body}]]></content:encoded>
</item>`;
const feed = (items) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Jobs &#8211; Jobspresso</title>${items.join("")}</channel></rss>`;

test("Jobspresso: newest-jobs feed, US filter, decoded fields, local filters", async () => {
  const calls = fakeFetch(() => ({
    body: feed([
      rssItem(1, { title: "Realtime &#038; Voice Software Engineer" }),
      rssItem(2, { where: "Canada" }),
      rssItem(3, { where: "Various US States" }),
      rssItem(4, { where: "Germany , Austria, Luxemburg" }),
      rssItem(5, { hoursAgo: 60 }),
      rssItem(6, { body: "<p>Vue only</p>" }),
      rssItem(7, { where: "Texas" }),
    ]),
  }));
  const { jobs, errors } = await scrapeJobs({
    sites: ["jobspresso"],
    title: "Software Engineer",
    stack: "React",
    count: 10,
    datePreset: "today",
    years: 5,
  });
  assert.deepEqual(errors, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "https://jobspresso.co/jobs/feed/", "path feed only (robots.txt disallows query strings)");
  assert.deepEqual(jobs.map((j) => j.company), ["Company 1", "Company 3", "Company 7"]);
  assert.equal(jobs[0].title, "Realtime & Voice Software Engineer");
  assert.equal(jobs[0].location, "Remote (United States)");
  assert.equal(jobs[0].job_url, "https://jobspresso.co/job/job-1/");
  assert.equal(jobs[0].years_required, 5);
});

test("Jobspresso: an HTML challenge page instead of the feed fails clearly", async () => {
  fakeFetch(() => ({ body: "<html><head><title>Just a moment...</title></head></html>" }));
  const { errors } = await scrapeJobs({ sites: ["jobspresso"], title: "Software Engineer", count: 5 });
  assert.match(errors[0], /jobspresso/i);
});

test("Hacker News: early in the month the window also reads last month's thread", async () => {
  const calls = fakeHn([comment(1, "A | Software Engineer | REMOTE (US)<p>x")], { threadAgeDays: 1, previous: "49522897" });
  await scrapeJobs({ sites: ["hackernews"], title: "Software Engineer", count: 5, datePreset: "3days" });
  assert.equal(new URL(calls[1]).searchParams.get("tags"), `comment,(story_${THREAD},story_49522897)`);
});

test("Hacker News: no thread from the last 45 days is an error, not an empty result", async () => {
  fakeHn([], { threadAgeDays: 50 });
  const { errors } = await scrapeJobs({ sites: ["hackernews"], title: "Software Engineer", count: 5 });
  assert.match(errors[0], /no 'Who is hiring\?' thread from the last 45 days/);
});

test("Himalayas: long country lists stay short in the sheet", async () => {
  fakeFetch(() => ({
    body: { totalCount: 1, jobs: [himRow(1, { locationRestrictions: ["United States", "Canada", "Mexico"] }), himRow(2, { locationRestrictions: ["United States", "Canada"] })] },
  }));
  const { jobs } = await scrapeJobs({ sites: ["himalayas"], title: "Software Engineer", count: 5 });
  assert.deepEqual(jobs.map((j) => j.location), ["Remote (US + 2 countries)", "Remote (US + 1 country)"]);
});

test("Jobspresso: a bare 'Remote' location stays; the log names the newest posting", async () => {
  fakeFetch(() => ({ body: feed([rssItem(1, { where: "Remote" })]) }));
  const progress = [];
  const { jobs } = await scrapeJobs({ sites: ["jobspresso"], title: "Software Engineer", count: 5, onProgress: (m) => progress.push(m) });
  assert.equal(jobs.length, 1);
  assert.ok(progress.some((m) => /newest posted \d{4}-\d{2}-\d{2}/.test(m)));
});

// ---- Turing (shape from the one known adapter, July 2026) ----
const turingRow = (id, extra = {}) => ({
  id,
  title: "Senior Software Engineer (AI evaluation)",
  locationType: "remote",
  roleGroup: "Engineering",
  oneLinerDescription: "Evaluate AI code in React and Python.",
  description: "<p>3+ years of experience.</p>",
  createdDate: new Date(Date.now() - 3600e3).toISOString().slice(0, 19).replace("T", " "),
  ...extra,
});

test("Turing: one call for the whole board, contract-only, explicit non-US wording drops", async () => {
  const bodies = [];
  fakeFetch((url, init) => {
    bodies.push(JSON.parse(init.body));
    return {
      body: {
        success: true,
        totalCount: 7,
        jobs: [
          turingRow(1),
          turingRow(2, { description: "<p>Candidates must reside in the United States.</p>" }),
          turingRow(3, { description: "<p>For professionals in non-US countries.</p>" }),
          turingRow(4, { description: "<p>Must be located in Canada.</p>" }),
          turingRow(5, { locationType: "on-site" }),
          turingRow(6, { locationType: null, description: "<p>Open to contractors inside or outside the US.</p>" }),
          turingRow(7, { title: "Tax Law Annotator" }),
        ],
      },
    };
  });
  const progress = [];
  let { jobs, errors } = await scrapeJobs({
    sites: ["turing"],
    title: "Software Engineer",
    stack: "React",
    count: 10,
    datePreset: "today",
    jobType: "contract",
    onProgress: (m) => progress.push(m),
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(bodies[0], { searchQuery: "", expertise: [], location: [], currentPage: 1, pageSize: 1000 });
  assert.deepEqual(jobs.map((j) => j.job_url), [1, 2, 6].map((id) => `https://work.turing.com/jobs?jobId=${id}`));
  assert.equal(jobs[0].company, "Turing");
  assert.equal(jobs[0].listing_type, "contract");
  assert.equal(jobs[1].location, "United States");
  assert.ok(progress.some((m) => /1 on-site, 2 not open to the US/.test(m)));
  // Full time: Turing has none
  ({ jobs } = await scrapeJobs({ sites: ["turing"], title: "Software Engineer", count: 10, jobType: "fulltime", onProgress: (m) => progress.push(m) }));
  assert.equal(jobs.length, 0);
  assert.ok(progress.some((m) => /all Turing roles are contract work/.test(m)));
});

test("Turing: blocked from the extension, the same call runs in a site tab", async () => {
  fakeFetch(() => ({ status: 403, body: "<html>Incapsula incident ID</html>" }));
  const sent = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: async (m) => {
        sent.push(m);
        return { status: 200, data: { success: true, totalCount: 1, jobs: [turingRow(9)] } };
      },
    },
  };
  const { jobs, errors } = await scrapeJobs({ sites: ["turing"], title: "Software Engineer", count: 5, jobType: "contract" });
  assert.deepEqual(errors, []);
  assert.equal(sent[0].type, "TURING_SCRAPE");
  assert.equal(jobs.length, 1);
});

test("Turing: an unexpected response shape fails loudly", async () => {
  fakeFetch(() => ({ body: { ok: true, items: [] } }));
  const { errors } = await scrapeJobs({ sites: ["turing"], title: "Software Engineer", count: 5, jobType: "contract" });
  assert.match(errors[0], /unexpected response/);
});
