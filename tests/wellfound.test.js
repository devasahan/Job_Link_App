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
          description: "Go services",
          yearsExperienceMin: 3,
        },
      ],
    },
  ]
);

const ROLE_PAGE_2 = listing({ page: 2, remote: true, role: "software-engineer" }, 3, [
  { id: "3", name: "Initech", jobs: [{ id: "201", title: "Software Engineer II", jobType: null }] },
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
  const calls = fakeSite({
    "/browse/remote-tech-jobs": { html: TAXONOMY },
    // Unknown role served as a different search: not our role
    "/role/r/data-wizard": { html: page(remote) },
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
  assert.deepEqual(r.dropped, { notUs: 1, tooOld: 1, title: 1, filters: 0 });
});

test("three pages in a row older than the window end the scrape", async () => {
  const stale = (n) =>
    listing({ page: n, remote: true, role: "software-engineer" }, 9, [
      { id: `s${n}`, name: `Old ${n}`, jobs: [{ id: `old${n}`, title: "Software Engineer", liveStartAt: nowS - 40 * 24 * HOUR }] },
    ]);
  const routes = { "/browse/remote-tech-jobs": { html: TAXONOMY } };
  routes["/role/r/software-engineer"] = { html: page(stale(1)) };
  for (let n = 2; n <= 9; n++) routes[`/role/r/software-engineer?page=${n}`] = { html: page(stale(n)) };
  const calls = fakeSite(routes);
  const r = await run({ title: "Software Engineer" });
  assert.equal(r.stoppedOld, true);
  assert.equal(r.pages, 3);
  assert.equal(calls.at(-1), "/role/r/software-engineer?page=3");
  assert.equal(r.dropped.tooOld, 3);
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
