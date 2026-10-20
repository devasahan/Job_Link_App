import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import "../extension/scrapers/title-match.js";
import "../extension/scrapers/job-filters.js";

// Site tabs in a fake browser: the real background worker and page scrapers
// run against these tabs and a fake fetch per site.

/** "https://www.dice.com/*" → RegExp */
function patternRe(pattern) {
  const [, scheme, host, path] = pattern.match(/^(https?):\/\/([^/]+)(\/.*)$/);
  const h = host.replace(/\./g, "\\.").replace(/^\*\\\./, "(?:[^/]+\\.)?");
  return new RegExp(`^${scheme}://${h}${path.replace(/[.?+^$()[\]{}|]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

let env;
beforeEach(() => {
  env = {
    tabs: new Map(),
    nextId: 1,
    clock: 0,
    log: [],
    store: {},
    onUpdated: new Set(),
    // url → final url after redirects
    redirect: (url) => url,
    // New tabs get this page title ("Just a moment..." = a security check)
    newTabTitle: "Jobs",
    newTabBroken: false,
    // (url: URL, init, tab) → {status, body}
    site: () => ({ status: 404, body: "" }),
  };
});

const addTab = (url, extra = {}) => {
  const tab = { id: env.nextId++, url, status: "complete", discarded: false, lastAccessed: ++env.clock, title: "Jobs", ...extra };
  env.tabs.set(tab.id, tab);
  return tab;
};
const creates = () => env.log.filter((l) => l.startsWith("create")).length;

// Enough DOMParser for the page scrapers: <title>, <h1>, no job cards
globalThis.DOMParser = class {
  parseFromString(html) {
    const text = (tag) => String(html).match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i"))?.[1] ?? "";
    return {
      title: text("title"),
      body: { textContent: String(html).replace(/<[^>]*>/g, "") },
      querySelectorAll: () => [],
      querySelector: (sel) => (sel === "h1" && text("h1") ? { textContent: text("h1") } : null),
      getElementById: () => null,
    };
  }
};

let onMessage;
globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (l) => (onMessage = l) },
    onInstalled: { addListener() {} },
  },
  tabs: {
    async query({ url, discarded }) {
      const re = patternRe(url);
      return [...env.tabs.values()]
        .filter((t) => re.test(t.url) && (discarded === undefined || t.discarded === discarded))
        .map((t) => ({ ...t }));
    },
    async get(id) {
      const tab = env.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}.`);
      return { ...tab };
    },
    async create({ url }) {
      const tab = addTab(env.redirect(url), {
        status: "loading",
        title: env.newTabTitle,
        broken: env.newTabBroken,
      });
      env.log.push(`create ${new URL(tab.url).host}`);
      setTimeout(() => {
        tab.status = "complete";
        for (const l of [...env.onUpdated]) l(tab.id, { status: "complete" });
      }, 1);
      return { ...tab };
    },
    onUpdated: {
      addListener: (l) => env.onUpdated.add(l),
      removeListener: (l) => env.onUpdated.delete(l),
    },
  },
  scripting: {
    async executeScript({ target, files, func, args }) {
      const tab = env.tabs.get(target.tabId);
      if (!tab) throw new Error("No tab with id");
      if (tab.broken) throw new Error("Frame with ID 0 is showing error page");
      if (files) return [{ result: undefined }];
      env.log.push(`run ${tab.id}`);
      tab.lastAccessed = ++env.clock;
      globalThis.location = new URL(tab.url);
      globalThis.document = { title: tab.title, body: { innerText: "" } };
      globalThis.fetch = async (u, init) => {
        const url = new URL(u, tab.url);
        const { status = 200, body = "" } = env.site(url, init, tab);
        const text = typeof body === "string" ? body : JSON.stringify(body);
        return { ok: status < 400, status, url: url.href, text: async () => text, json: async () => JSON.parse(text) };
      };
      return [{ result: JSON.parse(JSON.stringify((await func(...args)) ?? null)) }];
    },
  },
  storage: {
    session: {
      async get(key) {
        return { [key]: env.store[key] };
      },
      async set(values) {
        Object.assign(env.store, values);
      },
    },
  },
};

await import("../extension/background.js");

const send = (type, payload = {}) =>
  new Promise((resolve) => assert.equal(onMessage({ type, payload }, {}, resolve), true));

const BUILTIN_EMPTY = "<html><head><title>Remote jobs</title></head><body><h1>No job results</h1></body></html>";
const CHALLENGE = "<html><head><title>Just a moment...</title></head><body>cf-browser-verification</body></html>";

test("a rate limit in the user's tab is reported, with no new tab", async () => {
  addTab("https://builtin.com/my-page");
  env.site = () => ({ status: 429, body: "<html><title>Too Many Requests</title></html>" });
  const reply = await send("BUILTIN_SCRAPE", { searchTerm: "Software Engineer", days: 1 });
  assert.match(reply.error, /limiting requests \(HTTP 429\)/);
  assert.equal(creates(), 0);
  assert.deepEqual(env.log, ["run 1"]);
});

test("a security check in the user's tab is retried once in a new tab, which is left alone", async () => {
  addTab("https://builtin.com/my-page");
  env.site = (url, init, tab) => (tab.id === 1 ? { status: 403, body: CHALLENGE } : { body: BUILTIN_EMPTY });
  const reply = await send("BUILTIN_SCRAPE", { searchTerm: "Software Engineer", days: 1 });
  assert.equal(reply.error, null);
  assert.deepEqual(env.log, ["run 1", "create builtin.com", "run 2"]);
  assert.equal(env.tabs.get(1).url, "https://builtin.com/my-page", "the user's tab is never navigated");
});

test("a new tab that fails is not retried", async () => {
  env.newTabBroken = true;
  const reply = await send("BUILTIN_SCRAPE", { searchTerm: "Software Engineer", days: 1 });
  assert.match(reply.error, /error page/);
  assert.equal(creates(), 1);
});

test("with several site tabs open, the one used last runs the scrape", async () => {
  addTab("https://work.turing.com/jobs", { lastAccessed: 50 });
  addTab("https://work.turing.com/jobs?jobId=1", { lastAccessed: 99 });
  env.site = () => ({ body: { success: true, jobs: [], totalCount: 0 } });
  const reply = await send("TURING_SCRAPE", { body: {} });
  assert.equal(reply.status, 200);
  assert.deepEqual(env.log, ["run 2"]);
});

test("a ZipRecruiter geo-redirect is remembered, so the next run reuses that tab", async () => {
  env.redirect = (url) => url.replace("www.ziprecruiter.com", "www.ziprecruiter.co.uk");
  env.site = () => ({ body: "<html><title>Jobs</title></html>" });
  await send("ZIPRECRUITER_SCRAPE", { searchTerm: "Software Engineer" });
  assert.equal(env.store.zipRecruiterRegionalOrigin, "https://www.ziprecruiter.co.uk");
  await send("ZIPRECRUITER_SCRAPE", { searchTerm: "Software Engineer" });
  assert.deepEqual(env.log, ["create www.ziprecruiter.co.uk", "run 1", "run 1"]);
});

test("a ZipRecruiter regional tab that first showed a security check is reused after it", async () => {
  env.redirect = (url) => url.replace("www.ziprecruiter.com", "www.ziprecruiter.co.uk");
  env.newTabTitle = "Just a moment...";
  env.site = () => ({ body: "<html><title>Jobs</title></html>" });
  const first = await send("ZIPRECRUITER_SCRAPE", { searchTerm: "Software Engineer" });
  assert.match(first.error, /security check/);
  // The user passes the check in that tab
  env.tabs.get(1).title = "Jobs";
  const second = await send("ZIPRECRUITER_SCRAPE", { searchTerm: "Software Engineer" });
  assert.equal(second.error, null);
  assert.equal(creates(), 1);
});

test("ZipRecruiter search errors are reported, not an empty result", async () => {
  addTab("https://www.ziprecruiter.com/candidate/suggested-jobs");
  env.site = () => ({ status: 503, body: "Service Unavailable" });
  const reply = await send("ZIPRECRUITER_SCRAPE", { searchTerm: "Software Engineer" });
  assert.equal(reply.error, "ZipRecruiter HTTP 503");
  assert.equal(creates(), 0);
});
