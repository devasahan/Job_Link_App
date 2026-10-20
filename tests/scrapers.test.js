import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { scrapeJobs } from "../extension/scrapers/index.js";

const today = new Date().toISOString().slice(0, 10);
const DAY = 86400000;

// Just enough DOMParser for stripHtml()
globalThis.DOMParser = class {
  parseFromString(html) {
    return { body: { textContent: String(html).replace(/<[^>]*>/g, " ") } };
  }
};

let messages;
beforeEach(() => {
  messages = [];
});

/** Fake the background worker: tab scrapers reply with these jobs. */
function fakeTabScrape(jobs) {
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        messages.push(message);
        return { jobs: jobs.map((j) => ({ ...j })), rawCount: jobs.length };
      },
    },
  };
}

const card = (title, extra = {}) => ({
  title,
  company: `${title} Co`,
  location: "Remote",
  site: "zip_recruiter",
  listing_type: "",
  date_posted: today,
  is_remote: "Yes",
  job_url: `https://example.test/${encodeURIComponent(title)}`,
  description: "",
  years_required: "",
  ...extra,
});

test("boards without descriptions are searched with title + stack and keep their jobs", async () => {
  fakeTabScrape([card("Senior Frontend Engineer"), card("Frontend Engineer II")]);
  const { jobs, errors } = await scrapeJobs({
    sites: ["zip_recruiter", "dice"],
    title: "Frontend Engineer",
    stack: "React TypeScript",
    count: 10,
    datePreset: "today",
    years: "",
    jobType: "fulltime",
  });
  assert.deepEqual(errors, []);
  for (const m of messages) {
    assert.equal(m.payload.searchTerm, "Frontend Engineer React TypeScript", m.type);
  }
  // Same title + company from two boards collapses to one row each
  assert.deepEqual(
    jobs.map((j) => j.title),
    ["Senior Frontend Engineer", "Frontend Engineer II"]
  );
});

test("an empty title and stack searches broadly", async () => {
  fakeTabScrape([card("Anything")]);
  await scrapeJobs({ sites: ["zip_recruiter"], title: "", stack: "", count: 5 });
  assert.equal(messages[0].payload.searchTerm, "remote");
});

/** Fake apis.indeed.com: one response per page, newest jobs first. */
function fakeIndeed(pages) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const query = JSON.parse(init.body).query;
    calls.push(query);
    const n = calls.length - 1;
    const results = (pages[n] || []).map((j, i) => ({
      job: {
        key: `p${n}j${i}`,
        title: j.title,
        datePublished: j.ms,
        description: { html: `<p>${j.desc}</p>` },
        location: { formatted: { long: "Remote" } },
        employer: { name: `Co ${n}-${i}` },
        attributes: [],
        recruit: {},
      },
    }));
    const body = {
      data: {
        jobSearch: {
          pageInfo: { nextCursor: n + 1 < pages.length ? `c${n + 1}` : null },
          results,
        },
      },
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return calls;
}

test("Indeed checks the stack while paging and stops once results are too old", async () => {
  const now = Date.now();
  const calls = fakeIndeed([
    [
      { title: "Software Engineer", ms: now, desc: "React and TypeScript daily" },
      { title: "Software Engineer", ms: now, desc: "Vue shop" },
    ],
    [
      { title: "Software Engineer", ms: now - 3600000, desc: "We use React, TypeScript" },
      { title: "Software Engineer", ms: now - 5 * DAY, desc: "React TypeScript" },
    ],
    [
      { title: "Software Engineer", ms: now - 6 * DAY, desc: "React TypeScript" },
      { title: "Software Engineer", ms: now - 7 * DAY, desc: "React TypeScript" },
    ],
    [{ title: "Software Engineer", ms: now - 8 * DAY, desc: "React TypeScript" }],
  ]);
  const { jobs, errors } = await scrapeJobs({
    sites: ["indeed"],
    title: "Software Engineer",
    stack: "React TypeScript",
    count: 10,
    datePreset: "today",
  });
  assert.deepEqual(errors, []);
  assert.equal(jobs.length, 2, "two fresh React + TypeScript jobs");
  assert.equal(calls.length, 3, "page 3 was all too old, so page 4 is never fetched");
  assert.match(calls[0], /what: "Software Engineer React TypeScript"/);
});

test("Indeed keeps paging until Count stack matches are found", async () => {
  const now = Date.now();
  const calls = fakeIndeed([
    [{ title: "Software Engineer", ms: now, desc: "Angular" }],
    [{ title: "Software Engineer", ms: now, desc: "React" }],
    [{ title: "Software Engineer", ms: now, desc: "React" }],
  ]);
  const { jobs } = await scrapeJobs({
    sites: ["indeed"],
    title: "Software Engineer",
    stack: "React",
    count: 1,
    datePreset: "today",
  });
  assert.equal(jobs.length, 1);
  assert.equal(calls.length, 2, "stops as soon as Count is reached");
});
