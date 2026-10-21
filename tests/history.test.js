import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  downloadedCount,
  forgetDownloaded,
  jobKeys,
  loadDownloaded,
  rememberDownloaded,
} from "../extension/scrapers/history.js";
import { scrapeJobs } from "../extension/scrapers/index.js";

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const today = new Date().toISOString().slice(0, 10);

let store;
let messages;
beforeEach(() => {
  store = {};
  messages = [];
});

/** chrome.storage.local, plus a tab board (ZipRecruiter) that returns these jobs. */
function fakeChrome(boardJobs = []) {
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: store[key] };
        },
        async set(values) {
          Object.assign(store, JSON.parse(JSON.stringify(values)));
        },
        async remove(key) {
          delete store[key];
        },
      },
    },
    runtime: {
      sendMessage: async (message) => {
        messages.push(message);
        const jobs = boardJobs.slice(0, message.payload.resultsWanted).map((j) => ({ ...j }));
        return { jobs, rawCount: jobs.length };
      },
    },
  };
}

const job = (n, extra = {}) => ({
  title: `Software Engineer ${n}`,
  company: `Co ${n}`,
  location: "Remote",
  site: "zip_recruiter",
  listing_type: "",
  date_posted: today,
  is_remote: "Yes",
  job_url: `https://www.ziprecruiter.com/jobs//j?lvk=${n}`,
  description: "",
  years_required: "",
  ...extra,
});

test("a job is known by its link (without tracking parts) and by title + company", () => {
  const keys = jobKeys({
    title: "Sr. Software Engineer",
    company: "Acme, Inc.",
    site: "linkedin",
    job_url: "https://WWW.linkedin.com/jobs/view/123/?trk=public_jobs&refId=abc#apply",
  });
  assert.deepEqual(keys, ["url:www.linkedin.com/jobs/view/123", "job:sr software engineer|acme inc"]);
  // Every Turing role is "Turing": only the link identifies it
  assert.deepEqual(jobKeys({ title: "Python Engineer", company: "Turing", site: "turing", job_url: "https://work.turing.com/jobs?jobId=7" }), [
    "url:work.turing.com/jobs?jobId=7",
  ]);
});

test("downloads are remembered, counted per board, and forgotten after 30 days", async () => {
  fakeChrome();
  const now = Date.now();
  await rememberDownloaded([job(1), job(2, { site: "dice" })], now - 31 * DAY);
  await rememberDownloaded([job(3), job(4, { site: "dice" })], now - 60 * HOUR);
  await rememberDownloaded([job(5)], now - HOUR);
  assert.equal(await downloadedCount(now), 3, "the 31-day-old ones are gone");

  const seen = await loadDownloaded(now);
  assert.ok(seen.has(job(5)));
  assert.ok(!seen.has(job(1)));
  // The same job found later on another board, under another link
  assert.ok(seen.has(job(3, { site: "indeed", job_url: "https://www.indeed.com/viewjob?jk=x" })));
  // Within 24 h (+ a day): job 5 only; within 72 h (+ a day): jobs 3 and 5
  assert.equal(seen.recentCount("zip_recruiter", 24), 1);
  assert.equal(seen.recentCount("zip_recruiter", 72), 2);
  assert.equal(seen.recentCount("dice", 72), 1);

  // Downloading a job again refreshes it instead of adding it twice
  await rememberDownloaded([job(5), job(6)], now);
  assert.equal(await downloadedCount(now), 4);

  await forgetDownloaded();
  assert.equal(await downloadedCount(now), 0);
});

test("a run skips earlier downloads and still returns Count new jobs per board", async () => {
  const board = Array.from({ length: 10 }, (_, i) => job(i + 1));
  fakeChrome(board);
  await rememberDownloaded(board.slice(0, 3));

  const opts = { sites: ["zip_recruiter"], title: "Software Engineer", stack: "", count: 4, datePreset: "today" };
  const { jobs, skipped } = await scrapeJobs({ ...opts, downloaded: await loadDownloaded() });
  assert.equal(messages[0].payload.resultsWanted, 7, "Count + the 3 recent downloads from this board");
  assert.equal(skipped, 3);
  assert.deepEqual(jobs.map((j) => j.company), ["Co 4", "Co 5", "Co 6", "Co 7"]);

  // Without the option everything comes back
  const all = await scrapeJobs(opts);
  assert.deepEqual(all.jobs.map((j) => j.company), ["Co 1", "Co 2", "Co 3", "Co 4"]);
  assert.equal(all.skipped, 0);
});

test("when every match was downloaded before, the run has no new jobs", async () => {
  const board = [job(1), job(2)];
  fakeChrome(board);
  await rememberDownloaded(board);
  const { jobs, skipped } = await scrapeJobs({
    sites: ["zip_recruiter"],
    title: "",
    count: 5,
    downloaded: await loadDownloaded(),
  });
  assert.deepEqual(jobs, []);
  assert.equal(skipped, 2);
});
