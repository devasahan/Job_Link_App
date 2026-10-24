import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import "../extension/scrapers/title-match.js";
import "../extension/scrapers/job-filters.js";
import "../extension/scrapers/arc-page.js";
import { scrapeJobs } from "../extension/scrapers/index.js";

const BASE = "https://arc.dev";
const HOUR = 3600e3;

// Enough DOMParser for the link fallback: anchors with their text, no cards
globalThis.DOMParser = class {
  parseFromString(html) {
    const anchors = [...String(html).matchAll(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map(([, href, inner]) => ({
      getAttribute: () => href,
      textContent: inner.replace(/<[^>]*>/g, ""),
      closest: () => null,
    }));
    return { querySelectorAll: () => anchors, body: { textContent: String(html).replace(/<[^>]*>/g, "") } };
  }
};

beforeEach(() => {
  globalThis.document = { title: "Remote Jobs in the United States - Arc" };
});

const nextPage = (pageProps) =>
  `<html><head><title>Remote Jobs</title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    { props: { pageProps }, page: "/remote-jobs" }
  )}</script></body></html>`;

/** Fake arc.dev: path → {status?, html}. */
function fakeArc(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const path = String(url).replace(BASE, "");
    calls.push(path);
    const route = routes[path] || { status: 404, html: "<html>Not found</html>" };
    return { ok: (route.status || 200) < 400, status: route.status || 200, text: async () => route.html };
  };
  return calls;
}

const job = (key, extra = {}) => ({
  randomKey: key,
  title: "Senior Python Engineer",
  company: { name: `Co ${key}` },
  jobType: "full-time",
  countries: [{ name: "United States" }],
  postedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
  techStack: ["Python", "AWS"],
  description: "<p>Build APIs. 4+ years of experience.</p>",
  ...extra,
});

const run = (args) => globalThis.jbArcScrape({ hoursOld: 24, resultsWanted: 50, pauseMs: 0, ...args });

test("Arc: jobs come from the page data, open to the US, fresh and matching the title", async () => {
  const page1 = nextPage({
    jobs: [
      job("a1"),
      job("a2", { countries: [{ name: "Germany" }, { name: "Poland" }] }),
      job("a3", { postedAt: new Date(Date.now() - 5 * 24 * HOUR).toISOString() }),
      job("a4", { title: "Product Designer" }),
      job("a5", { countries: [], title: "Python Developer" }),
    ],
  });
  const calls = fakeArc({ "/en-us/remote-jobs": { html: page1 }, "/en-us/remote-jobs?page=2": { html: page1 } });
  const r = await run({ title: "Python Developer" });
  assert.deepEqual(
    r.jobs.map((j) => [j.company, j.title, j.location]),
    [
      ["Co a1", "Senior Python Engineer", "Remote (United States)"],
      ["Co a5", "Python Developer", "Remote"],
    ]
  );
  const a1 = r.jobs[0];
  assert.equal(a1.site, "arc");
  assert.equal(a1.job_url, "https://arc.dev/remote-jobs/details/a1");
  assert.equal(a1.listing_type, "full-time");
  assert.equal(a1.years_required, 4);
  assert.match(a1.description, /Tech stack: Python, AWS/);
  assert.deepEqual(r.dropped, { notUs: 1, tooOld: 1, title: 1, filters: 0 });
  assert.equal(r.source, "page data");
  assert.deepEqual(calls, ["/en-us/remote-jobs", "/en-us/remote-jobs?page=2"], "page 2 had nothing new, so it stopped");
});

test("Arc: a job link in the data is used as it is", async () => {
  fakeArc({ "/en-us/remote-jobs": { html: nextPage({ data: { list: [job("b1", { url: "/remote-jobs/j/acme-python-engineer-b1" })] } }) } });
  const r = await run({});
  assert.equal(r.jobs[0].job_url, "https://arc.dev/remote-jobs/j/acme-python-engineer-b1");
});

test("Arc: without page data the job links on the page are used", async () => {
  const html = `<html><body>
    <a href="/remote-jobs/details/backend-engineer-k6xoz8tkay">Backend Engineer</a>
    <a href="/remote-jobs/j/redirect/p1cx6p24ft">Join Arc to apply</a>
    <a href="/remote-jobs/python">Python jobs</a>
  </body></html>`;
  fakeArc({ "/en-us/remote-jobs": { html } });
  const r = await run({ title: "Backend Developer" });
  assert.deepEqual(r.jobs.map((j) => [j.title, j.job_url]), [["Backend Engineer", "https://arc.dev/remote-jobs/details/backend-engineer-k6xoz8tkay"]]);
  assert.equal(r.source, "links");
});

test("Arc: a Cloudflare check is flagged so a new tab can show it", async () => {
  fakeArc({ "/en-us/remote-jobs": { status: 403, html: "<html><head><title>Just a moment...</title></head></html>" } });
  const r = await run({});
  assert.equal(r.blocked, true);
  assert.match(r.error, /security check/);
  globalThis.document = { title: "Just a moment..." };
  assert.equal((await run({})).blocked, true);
});

test("Arc: a page with no jobs at all fails loudly", async () => {
  fakeArc({ "/en-us/remote-jobs": { html: "<html><body>New layout</body></html>" } });
  const r = await run({});
  assert.match(r.error, /format changed/);
});

test("Arc board: asks the background for an arc.dev tab scrape and logs what it read", async () => {
  const messages = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: async (m) => {
        messages.push(m);
        return {
          jobs: [{ title: "Python Engineer", company: "Acme", site: "arc", date_posted: new Date().toISOString(), job_url: "https://arc.dev/remote-jobs/details/x", description: "" }],
          rawCount: 3,
          pages: 1,
          source: "page data",
          dropped: { notUs: 2 },
        };
      },
    },
  };
  const progress = [];
  const { jobs } = await scrapeJobs({ sites: ["arc"], title: "Python Developer", count: 5, onProgress: (m) => progress.push(m) });
  assert.equal(messages[0].type, "ARC_SCRAPE");
  assert.equal(jobs.length, 1);
  assert.ok(progress.some((m) => /Arc: 1 page\(s\) \(from page data\), 3 scanned → 1 matching \(skipped: 2 not open to the US\)/.test(m)), progress.join("\n"));
});
