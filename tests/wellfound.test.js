import { test } from "node:test";
import assert from "node:assert/strict";

import "../extension/scrapers/title-match.js";
import "../extension/scrapers/job-filters.js";
import "../extension/scrapers/wellfound-page.js";
import { scrapeJobs } from "../extension/scrapers/index.js";

const BASE = "https://wellfound.com";
const nowS = Math.floor(Date.now() / 1000);
const HOUR = 3600;

const page = (cache) =>
  `<html><head><title>Jobs</title></head><body><div id="__next"></div>` +
  `<script id="__NEXT_DATA__" type="application/json" crossorigin="anonymous">${JSON.stringify(
    { props: { pageProps: { apolloState: { data: cache } } }, page: "/seoLanding/roleSearch" }
  )}</script></body></html>`;

const searchKey = (args) => `seoLandingPageJobSearchResults(${JSON.stringify(args)})`;

/** An Apollo cache for one listing page. */
function listing(args, pageCount, startups) {
  const cache = {
    ROOT_QUERY: {
      __typename: "Query",
      talent: {
        __typename: "Talent",
        [searchKey(args)]: {
          __typename: "Results",
          pageCount,
          perPage: 20,
          startups: startups.map((s) => ({ __ref: `StartupResult:${s.id}` })),
        },
      },
    },
  };
  for (const s of startups) {
    cache[`StartupResult:${s.id}`] = {
      __typename: "StartupResult",
      id: s.id,
      name: s.name,
      slug: s.name.toLowerCase(),
      highlightedJobListings: s.jobs.map((j) => ({ __ref: `JobListingSearchResult:${j.id}` })),
    };
    for (const j of s.jobs) {
      cache[`JobListingSearchResult:${j.id}`] = {
        __typename: "JobListingSearchResult",
        slug: j.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        remote: true,
        locationNames: ["San Francisco"],
        acceptedRemoteLocationNames: ["United States"],
        jobType: "full-time",
        liveStartAt: nowS - HOUR,
        description: "",
        yearsExperienceMin: null,
        ...j,
      };
    }
  }
  return cache;
}

const ROLE_PAGE_1 = listing(
  { page: 1, remote: true, role: "software-engineer" },
  3,
  [
    {
      id: "1",
      name: "Acme",
      jobs: [
        {
          id: "101",
          title: "Senior Software Engineer",
          description: "We build with React and TypeScript. 5+ years of experience.",
        },
        { id: "102", title: "Software Engineer", acceptedRemoteLocationNames: ["Europe"] },
        { id: "103", title: "Senior Software Engineer", liveStartAt: nowS - 5 * 24 * HOUR },
      ],
    },
    {
      id: "2",
      name: "Globex",
      jobs: [
        { id: "104", title: "Product Designer" },
        {
          id: "105",
          title: "Software Engineer",
          jobType: "full_time",
          // Client-hydrated shape
          acceptedRemoteLocationNames: { type: "json", json: ["North America"] },
          locationNames: { type: "json", json: ["Austin"] },
          liveStartAt: nowS - 2 * HOUR,
          description: "Go services. 2+ years of experience.",
          yearsExperienceMin: 3,
        },
      ],
    },
  ]
);

const ROLE_PAGE_2 = listing({ page: 2, remote: true, role: "software-engineer" }, 3, [
  { id: "3", name: "Initech", jobs: [{ id: "201", title: "Software Engineer II", jobType: null, description: "Rust services" }] },
]);

const TAXONOMY = page({
  ROOT_QUERY: { __typename: "Query" },
  "SeoRoleKeyword:1": { __typename: "SeoRoleKeyword", slug: "software-engineer", displayName: "Software Engineer" },
  "SeoRoleKeyword:2": { __typename: "SeoRoleKeyword", slug: "engineering-manager", displayName: "Engineering Manager" },
  "SeoRoleKeyword:3": { __typename: "SeoRoleKeyword", slug: "engineer", displayName: "Engineer" },
});

/** Fake wellfound.com. routes: path+query → {status?, html, url?}. */
function fakeSite(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const path = url.replace(BASE, "");
    calls.push(path);
    const route = routes[path] || { status: 404, html: "<html>Not found</html>" };
    if (route.throws) throw route.throws;
    return {
      ok: (route.status || 200) < 400,
      status: route.status || 200,
      url: route.url || url,
      text: async () => route.html,
    };
  };
  return calls;
}

const ROLE_SITE = {
  "/browse/remote-tech-jobs": { html: TAXONOMY },
  "/role/r/software-engineer": { html: page(ROLE_PAGE_1) },
  "/role/r/software-engineer?page=2": { html: page(ROLE_PAGE_2) },
  // Past the last page Wellfound redirects to page 1
  "/role/r/software-engineer?page=3": {
    html: page(ROLE_PAGE_1),
    url: `${BASE}/role/r/software-engineer`,
  },
};

const run = (args) =>
  globalThis.jbWellfoundScrape({ hoursOld: 24, resultsWanted: 50, pauseMs: 0, ...args });

test("role page: US-remote, fresh, title-matching jobs with company and job links", async () => {
  const calls = fakeSite(ROLE_SITE);
  const result = await run({ title: "Software Engineer" });
  assert.equal(result.error, undefined);
  assert.equal(result.role, "software-engineer");
  assert.deepEqual(
    result.jobs.map((j) => [j.title, j.company, j.job_url]),
    [
      ["Senior Software Engineer", "Acme", `${BASE}/jobs/101-senior-software-engineer`],
      ["Software Engineer", "Globex", `${BASE}/jobs/105-software-engineer`],
      ["Software Engineer II", "Initech", `${BASE}/jobs/201-software-engineer-ii`],
    ]
  );
  const [first, second] = result.jobs;
  assert.equal(first.location, "Remote (United States)");
  assert.equal(first.years_required, 5, "read from the description");
  assert.equal(first.site, "wellfound");
  assert.match(first.date_posted, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(second.location, "Remote (North America)");
  assert.equal(second.listing_type, "full-time");
  assert.equal(second.years_required, 3, "yearsExperienceMin wins");
  assert.equal(result.rawCount, 6);
  assert.deepEqual(calls, [
    "/browse/remote-tech-jobs",
    "/role/r/software-engineer",
    "/role/r/software-engineer?page=2",
    "/role/r/software-engineer?page=3",
  ]);
});

test("stack, years and type filters run while paging", async () => {
  fakeSite(ROLE_SITE);
  let r = await run({ title: "Software Engineer", stack: "React" });
  assert.deepEqual(r.jobs.map((j) => j.title), ["Senior Software Engineer"]);
  r = await run({ title: "Software Engineer", years: 3 });
  assert.deepEqual(r.jobs.map((j) => j.title), ["Software Engineer", "Software Engineer II"]);
  r = await run({ title: "Software Engineer", jobType: "contract" });
  assert.deepEqual(
    r.jobs.map((j) => j.title),
    ["Software Engineer II"],
    "full-time listings drop; the one without a type stays"
  );
});

test("the 3-day window keeps older listings", async () => {
  fakeSite(ROLE_SITE);
  const r = await run({ title: "Software Engineer", hoursOld: 6 * 24 });
  assert.ok(r.jobs.some((j) => j.job_url.endsWith("/103-senior-software-engineer")));
});

test("stops at Count", async () => {
  const calls = fakeSite(ROLE_SITE);
  const r = await run({ title: "Software Engineer", resultsWanted: 1 });
  assert.equal(r.jobs.length, 1);
  assert.equal(calls.at(-1), "/role/r/software-engineer");
});

test("seniority words are dropped to find the role when the role list can't load", async () => {
  const calls = fakeSite({ ...ROLE_SITE, "/browse/remote-tech-jobs": { status: 500, html: "" } });
  const r = await run({ title: "Senior Software Engineer" });
  assert.equal(r.role, "software-engineer");
  assert.ok(calls.includes("/role/r/senior-software-engineer"));
  assert.deepEqual(r.jobs.map((j) => j.title), ["Senior Software Engineer"]);
});

test("a title that isn't a Wellfound role searches every remote role", async () => {
  const remote = listing({ page: 1, remote: true }, 1, [
    { id: "9", name: "Hooli", jobs: [{ id: "901", title: "Data Wizard" }, { id: "902", title: "Chef" }] },
  ]);
  const errorPage = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    page: "/_error",
    props: { pageProps: { apolloState: { data: { ROOT_QUERY: {} } } } },
  })}</script></html>`;
  const calls = fakeSite({
    "/browse/remote-tech-jobs": { html: TAXONOMY },
    // Unknown roles redirect (303) elsewhere, or render the error page
    "/role/r/data-wizard": { html: page(remote), url: `${BASE}/remote` },
    "/role/r/wizard": { html: errorPage },
    "/remote": { html: page(remote) },
  });
  const r = await run({ title: "Data Wizard" });
  assert.equal(r.role, "");
  assert.deepEqual(r.jobs.map((j) => j.title), ["Data Wizard"]);
  assert.equal(calls.at(-1), "/remote");
});

test("a security check is reported, not swallowed", async () => {
  fakeSite({
    "/browse/remote-tech-jobs": { status: 403, html: "" },
    "/role/r/software-engineer": {
      status: 403,
      html: '<html><iframe src="https://geo.captcha-delivery.com/captcha/"></iframe></html>',
    },
  });
  const r = await run({ title: "Software Engineer" });
  assert.match(r.error, /security check/);
});

test("a page without __NEXT_DATA__ fails loudly", async () => {
  fakeSite({ "/remote": { html: "<html><body>new app router page</body></html>" } });
  const r = await run({ title: "" });
  assert.match(r.error, /page format changed/);
});

test("the page limit is reported", async () => {
  fakeSite(ROLE_SITE);
  const r = await run({ title: "Software Engineer", maxPages: 1 });
  assert.equal(r.hitPageLimit, true);
  assert.equal(r.pages, 1);
});

test("the extension asks the background for Wellfound with title + stack and filters again", async () => {
  const sent = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        sent.push(message);
        return {
          jobs: [
            { title: "Software Engineer", company: "A", description: "React", date_posted: "", years_required: "" },
            { title: "Software Engineer", company: "B", description: "Vue", date_posted: "", years_required: "" },
          ],
          rawCount: 2,
          pages: 1,
          role: "software-engineer",
        };
      },
    },
  };
  const progress = [];
  const { jobs, errors } = await scrapeJobs({
    sites: ["wellfound"],
    title: "Software Engineer",
    stack: "React",
    count: 5,
    datePreset: "3days",
    onProgress: (m) => progress.push(m),
  });
  assert.deepEqual(errors, []);
  assert.equal(sent[0].type, "WELLFOUND_SCRAPE");
  assert.deepEqual(
    { title: sent[0].payload.title, stack: sent[0].payload.stack, hoursOld: sent[0].payload.hoursOld },
    { title: "Software Engineer", stack: "React", hoursOld: 72 }
  );
  assert.deepEqual(jobs.map((j) => j.company), ["A"]);
  assert.ok(progress.some((m) => /Wellfound \(role "software-engineer"\): 1 page/.test(m)));
});

test("skipped jobs are counted by reason", async () => {
  fakeSite(ROLE_SITE);
  const r = await run({ title: "Software Engineer" });
  assert.deepEqual(r.dropped, { notRemote: 0, notUs: 1, tooOld: 1, title: 1, filters: 0 });
});

test("listings aren't date-sorted: fresh jobs on later pages are still found", async () => {
  const at = (n, liveStartAt) =>
    listing({ page: n, remote: true, role: "software-engineer" }, 6, [
      { id: `c${n}`, name: `Co ${n}`, jobs: [{ id: `j${n}`, title: "Software Engineer", liveStartAt }] },
    ]);
  const routes = { "/browse/remote-tech-jobs": { html: TAXONOMY } };
  routes["/role/r/software-engineer"] = { html: page(at(1, nowS - 40 * 24 * HOUR)) };
  for (let n = 2; n <= 6; n++) {
    const fresh = n === 4 || n === 5;
    routes[`/role/r/software-engineer?page=${n}`] = { html: page(at(n, fresh ? nowS - HOUR : nowS - 40 * 24 * HOUR)) };
  }
  const calls = fakeSite(routes);
  const r = await run({ title: "Software Engineer" });
  assert.deepEqual(r.jobs.map((j) => j.company), ["Co 4", "Co 5"]);
  assert.equal(r.pages, 6, "stops at pageCount");
  assert.equal(calls.at(-1), "/role/r/software-engineer?page=6");
});

test("older Apollo references ({type: 'id'}) still link jobs to companies", async () => {
  const cache = listing({ page: 1, remote: true, role: "software-engineer" }, 1, [
    { id: "7", name: "Umbrella", jobs: [{ id: "701", title: "Software Engineer" }] },
  ]);
  cache["StartupResult:7"].highlightedJobListings = [
    { type: "id", id: "JobListingSearchResult:701", generated: false },
  ];
  fakeSite({ "/browse/remote-tech-jobs": { html: TAXONOMY }, "/role/r/software-engineer": { html: page(cache) } });
  const r = await run({ title: "Software Engineer" });
  assert.deepEqual(r.jobs.map((j) => j.company), ["Umbrella"]);
});

test("a DataDome block page served with 200 is reported", async () => {
  fakeSite({
    "/remote": {
      html: "<html><head><title>wellfound.com</title></head><body><script>var dd={'rt':'c','cid':'x','hsh':'y','host':'ddm.wellfound.com'}</script></body></html>",
    },
  });
  const r = await run({ title: "" });
  assert.match(r.error, /security check/);
});

/** The same role pages, with the search args written in other shapes. */
function rekey(cache, key) {
  const talent = cache.ROOT_QUERY.talent;
  const [old] = Object.keys(talent).filter((k) => k.startsWith("seoLandingPageJobSearchResults"));
  talent[key] = talent[old];
  delete talent[old];
  return cache;
}

test("role and page are read from nested or Apollo 3 search keys", async () => {
  for (const shape of [
    (n) => `seoLandingPageJobSearchResults(${JSON.stringify({ filterConfigurationInput: { page: n, remote: true, roleSlug: "software-engineer" } })})`,
    (n) => `seoLandingPageJobSearchResults:${JSON.stringify({ page: n, role: "software-engineer" })}`,
    () => "seoLandingPageJobSearchResults",
  ]) {
    const p1 = rekey(structuredClone(ROLE_PAGE_1), shape(1));
    const p2 = rekey(structuredClone(ROLE_PAGE_2), shape(2));
    fakeSite({
      ...ROLE_SITE,
      "/role/r/software-engineer": { html: page(p1) },
      "/role/r/software-engineer?page=2": { html: page(p2) },
    });
    const r = await run({ title: "Software Engineer" });
    assert.equal(r.role, "software-engineer", shape(1));
    assert.equal(r.jobs.length, 3, shape(1));
  }
});

test("a role page that names a different role is not used", async () => {
  const other = listing({ page: 1, remote: true, role: "product-designer" }, 1, [
    { id: "8", name: "Wrong", jobs: [{ id: "801", title: "Software Engineer" }] },
  ]);
  const remote = listing({ page: 1, remote: true }, 1, [
    { id: "9", name: "Right", jobs: [{ id: "901", title: "Software Engineer" }] },
  ]);
  fakeSite({
    "/browse/remote-tech-jobs": { status: 500, html: "" },
    "/role/r/software-engineer": { html: page(other) },
    "/remote": { html: page(remote) },
  });
  const r = await run({ title: "Software Engineer" });
  assert.deepEqual(r.jobs.map((j) => j.company), ["Right"]);
});

test("only the page's own companies' jobs are read", async () => {
  const cache = structuredClone(ROLE_PAGE_2);
  // A job cached by some other query on the page
  cache["JobListingSearchResult:999"] = {
    __typename: "JobListingSearchResult", id: "999", title: "Software Engineer", slug: "x",
    remote: true, liveStartAt: nowS, acceptedRemoteLocationNames: [], jobType: "full-time",
  };
  fakeSite({ ...ROLE_SITE, "/role/r/software-engineer?page=2": { html: page(cache) } });
  const r = await run({ title: "Software Engineer" });
  assert.ok(!r.jobs.some((j) => j.job_url.includes("/999-")));
});

test("on-site kinds are not remote; remote kinds are", async () => {
  const cache = listing({ page: 1, remote: true, role: "software-engineer" }, 1, [
    {
      id: "1",
      name: "Kinds",
      jobs: [
        { id: "1", title: "Software Engineer A", remoteConfig: { kind: "ONSITE" } },
        { id: "2", title: "Software Engineer B", remoteConfig: { kind: "ONSITE", wfhFlexible: true } },
        { id: "3", title: "Software Engineer C", remote: false, remoteConfig: { kind: "NO_REMOTE" } },
        { id: "4", title: "Software Engineer D", remote: undefined, remoteConfig: { kind: "REMOTE_ONLY" } },
        { id: "5", title: "Software Engineer E", remote: false },
      ],
    },
  ]);
  fakeSite({ "/browse/remote-tech-jobs": { html: TAXONOMY }, "/role/r/software-engineer": { html: page(cache) } });
  const r = await run({ title: "Software Engineer" });
  assert.deepEqual(r.jobs.map((j) => j.title), ["Software Engineer B", "Software Engineer D"]);
  assert.equal(r.dropped.notRemote, 3);
});

test("remote limited to a US state or city counts as US", async () => {
  const where = (id, list) => ({ id, title: `Software Engineer ${id}`, acceptedRemoteLocationNames: list });
  const cache = listing({ page: 1, remote: true, role: "software-engineer" }, 1, [
    {
      id: "1",
      name: "Geo",
      jobs: [
        where("1", ["California"]),
        where("2", ["Portland, OR"]),
        where("3", ["New York City"]),
        where("4", ["London, UK"]),
        where("5", ["Canada"]),
        where("6", ["Toronto, ON"]),
      ],
    },
  ]);
  fakeSite({ "/browse/remote-tech-jobs": { html: TAXONOMY }, "/role/r/software-engineer": { html: page(cache) } });
  const r = await run({ title: "Software Engineer" });
  assert.deepEqual(r.jobs.map((j) => j.title.split(" ").at(-1)), ["1", "2", "3"]);
});

test("a long remote-location list stays short in the sheet", async () => {
  const many = ["Alabama", "Alaska", "Arizona", "Arkansas", "California"];
  const cache = listing({ page: 1, remote: true, role: "software-engineer" }, 1, [
    { id: "1", name: "Many", jobs: [{ id: "1", title: "Software Engineer", acceptedRemoteLocationNames: many }] },
  ]);
  fakeSite({ "/browse/remote-tech-jobs": { html: TAXONOMY }, "/role/r/software-engineer": { html: page(cache) } });
  const r = await run({ title: "Software Engineer" });
  assert.equal(r.jobs[0].location, "Remote (Alabama, Alaska, Arizona, …)");
});

test("role list picks exact words, not prefixes", async () => {
  const roles = (list) =>
    page(Object.fromEntries(list.map(([slug, name], i) => [
      `SeoRoleKeyword:${i}`, { __typename: "SeoRoleKeyword", slug, displayName: name },
    ])));
  const cases = [
    ["JavaScript Developer", [["java-developer", "Java Developer"], ["javascript-developer", "JavaScript Developer"]], "javascript-developer"],
    ["Rust Developer", [["c-developer", "C Developer"]], "rust-developer"],
    ["Software Engineering Manager", [["software-engineer", "Software Engineer"], ["engineering-manager", "Engineering Manager"]], "engineering-manager"],
    ["Software Engineering Manager", [["engineering-manager", "Engineering Manager"], ["software-engineer", "Software Engineer"]], "engineering-manager"],
  ];
  for (const [title, list, want] of cases) {
    const jobPage = listing({ page: 1, remote: true, role: want }, 1, [
      { id: "1", name: "Co", jobs: [{ id: "1", title }] },
    ]);
    const calls = fakeSite({
      "/browse/remote-tech-jobs": { html: roles(list) },
      [`/role/r/${want}`]: { html: page(jobPage) },
    });
    const r = await run({ title });
    assert.equal(r.role, want, `${title} → ${calls.join(" ")}`);
  }
});

test("yearsExperienceMin 0 doesn't hide the years in the description", async () => {
  const cache = listing({ page: 1, remote: true, role: "software-engineer" }, 1, [
    { id: "1", name: "Y", jobs: [{ id: "1", title: "Software Engineer", yearsExperienceMin: 0, description: "5+ years of experience" }] },
  ]);
  fakeSite({ "/browse/remote-tech-jobs": { html: TAXONOMY }, "/role/r/software-engineer": { html: page(cache) } });
  const r = await run({ title: "Software Engineer" });
  assert.equal(r.jobs[0].years_required, 5);
});

test("a network error after page 1 keeps the jobs found so far", async () => {
  fakeSite({ ...ROLE_SITE, "/role/r/software-engineer?page=2": { throws: new TypeError("Failed to fetch") } });
  const r = await run({ title: "Software Engineer" });
  assert.equal(r.jobs.length, 2);
  assert.match(r.error, /request failed/);
  const timeout = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
  fakeSite({ ...ROLE_SITE, "/role/r/software-engineer?page=2": { throws: timeout } });
  assert.match((await run({ title: "Software Engineer" })).error, /timed out/);
});

test("a page with job data is fine even if it mentions DataDome", async () => {
  const html = page(ROLE_PAGE_1).replace(
    "</body>",
    '<script src="https://ddm.wellfound.com/tags.js"></script><!-- geo.captcha-delivery.com --></body>'
  );
  fakeSite({ ...ROLE_SITE, "/role/r/software-engineer": { html } });
  const r = await run({ title: "Software Engineer" });
  assert.equal(r.error, undefined);
  assert.ok(r.jobs.length);
});

test("an app-router page says the format moved", async () => {
  fakeSite({ "/remote": { html: '<html><script>self.__next_f.push([1,"x"])</script></html>' } });
  assert.match((await run({ title: "" })).error, /new page format/);
});

test("a stop partway is reported in the run log", async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async () => ({
        jobs: [{ title: "Software Engineer", company: "A", description: "", date_posted: "", years_required: "" }],
        rawCount: 1,
        pages: 1,
        role: "software-engineer",
        error: "Wellfound security check is open in a tab. Complete it, then press OK again.",
      }),
    },
  };
  const progress = [];
  const { jobs } = await scrapeJobs({ sites: ["wellfound"], title: "Software Engineer", count: 5, onProgress: (m) => progress.push(m) });
  assert.equal(jobs.length, 1);
  assert.ok(progress.some((m) => /Wellfound stopped early, results may be incomplete: Wellfound security check/.test(m)));
});

test("Count counts only full matches: paging goes on past non-matches", async () => {
  const calls = fakeSite(ROLE_SITE);
  const r = await run({ title: "Software Engineer", stack: "Rust", resultsWanted: 1 });
  assert.deepEqual(r.jobs.map((j) => j.title), ["Software Engineer II"]);
  assert.ok(calls.includes("/role/r/software-engineer?page=2"));
});

test("the role list finds the role inside a longer title, with no guessing first", async () => {
  const roles = page({
    "SeoRoleKeyword:1": { __typename: "SeoRoleKeyword", slug: "frontend-engineer", displayName: "Frontend Engineer" },
  });
  const jobPage = listing({ page: 1, remote: true, role: "frontend-engineer" }, 1, [
    { id: "1", name: "Co", jobs: [{ id: "1", title: "Senior React Frontend Engineer" }] },
  ]);
  const calls = fakeSite({
    "/browse/remote-tech-jobs": { html: roles },
    "/role/r/frontend-engineer": { html: page(jobPage) },
  });
  const r = await run({ title: "Senior React Frontend Engineer" });
  assert.equal(r.role, "frontend-engineer");
  assert.equal(calls[1], "/role/r/frontend-engineer");
});

test("the end of the listing is found without pageCount", async () => {
  const at = (n) =>
    listing({ page: n, remote: true, role: "software-engineer" }, null, [
      { id: `c${n}`, name: `Co ${n}`, jobs: [{ id: `j${n}`, title: "Software Engineer" }] },
    ]);
  const base = { "/browse/remote-tech-jobs": { html: TAXONOMY }, "/role/r/software-engineer": { html: page(at(1)) } };
  // 1) Redirected back to page 1
  let calls = fakeSite({
    ...base,
    "/role/r/software-engineer?page=2": { html: page(at(1)), url: `${BASE}/role/r/software-engineer` },
  });
  let r = await run({ title: "Software Engineer" });
  assert.equal(r.pages, 1);
  assert.equal(calls.length, 3);
  // 2) Page 1 served at ?page=2 with no redirect
  calls = fakeSite({ ...base, "/role/r/software-engineer?page=2": { html: page(at(1)) } });
  r = await run({ title: "Software Engineer" });
  assert.equal(r.pages, 1);
  assert.equal(calls.length, 3);
  // 3) No page argument at all: a page of only repeats ends it
  const plain = (cache) => rekey(cache, "seoLandingPageJobSearchResults");
  calls = fakeSite({
    "/browse/remote-tech-jobs": { html: TAXONOMY },
    "/role/r/software-engineer": { html: page(plain(at(1))) },
    "/role/r/software-engineer?page=2": { html: page(plain(at(2))) },
    "/role/r/software-engineer?page=3": { html: page(plain(at(2))) },
  });
  r = await run({ title: "Software Engineer" });
  assert.equal(r.pages, 2);
  assert.equal(calls.length, 4);
});

test("Wellfound's years field and the description: the higher wins", async () => {
  fakeSite(ROLE_SITE);
  const r = await run({ title: "Software Engineer" });
  const globex = r.jobs.find((j) => j.company === "Globex");
  assert.equal(globex.years_required, 3, "yearsExperienceMin 3 beats '2+ years' in the text");
});
