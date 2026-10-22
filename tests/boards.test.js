import { test } from "node:test";
import assert from "node:assert/strict";

import { scrapeJobs } from "../extension/scrapers/index.js";

const today = new Date().toISOString().slice(0, 10);

/**
 * A tiny DOMParser for LinkedIn's guest cards: enough of querySelector for
 * the "tag.class" and "tag.class tag" selectors linkedin.js uses.
 */
function element(html) {
  const find = (selector) => {
    const [outer, inner] = selector.split(" ");
    const [tag, cls] = outer.split(".");
    const re = new RegExp(
      `<${tag}\\b([^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*)>([\\s\\S]*?)</${tag}>`,
      "i"
    );
    const m = html.match(re);
    if (!m) return null;
    const el = { attrs: m[1], html: m[2] };
    if (inner) {
      const im = el.html.match(new RegExp(`<${inner}\\b([^>]*)>([\\s\\S]*?)</${inner}>`, "i"));
      return im ? node(im[1], im[2]) : null;
    }
    return node(el.attrs, el.html);
  };
  const node = (attrs, inner) => ({
    textContent: inner.replace(/<[^>]*>/g, ""),
    getAttribute: (name) => attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null,
    querySelector: (sel) => element(inner).querySelector(sel),
  });
  return {
    querySelector: find,
    querySelectorAll: (selector) => {
      const [tag, cls] = selector.split(".");
      const re = new RegExp(`<${tag}\\b[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
      return [...html.matchAll(re)].map((m) => element(m[1]));
    },
  };
}
globalThis.DOMParser = class {
  parseFromString(html) {
    return { ...element(String(html)), body: { textContent: String(html).replace(/<[^>]*>/g, "") } };
  }
};

const card = (title, company, id) => `<div class="base-search-card">
  <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/x-${id}?trk=1">link</a>
  <h3 class="base-search-card__title">${title}</h3>
  <h4 class="base-search-card__subtitle"><a href="#">${company}</a></h4>
  <span class="job-search-card__location">United States</span>
  <time class="job-search-card__listdate" datetime="${today}">today</time>
</div>`;

test("LinkedIn: searched with title + stack; cards without descriptions keep their jobs", async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const start = new URL(url).searchParams.get("start");
    const body = start === "0" ? card("Senior Frontend Engineer", "Acme", 1) + card("Frontend Engineer", "Beta", 2) : "";
    return { ok: true, status: 200, text: async () => body };
  };
  const { jobs, errors } = await scrapeJobs({
    sites: ["linkedin"],
    title: "Frontend Engineer",
    stack: "React TypeScript",
    count: 5,
    datePreset: "today",
  });
  assert.deepEqual(errors, []);
  assert.equal(new URL(urls[0]).searchParams.get("keywords"), "Frontend Engineer React TypeScript");
  assert.deepEqual(jobs.map((j) => [j.title, j.company]), [
    ["Senior Frontend Engineer", "Acme"],
    ["Frontend Engineer", "Beta"],
  ]);
});

test("Glassdoor: searched with title + stack; jobs without the stack in their text stay", async () => {
  const sent = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: async (m) => {
        sent.push(m);
        return {
          jobs: [
            { title: "Frontend Engineer", company: "G", description: "Short snippet", date_posted: today, years_required: "" },
          ],
          rawCount: 1,
        };
      },
    },
  };
  const { jobs } = await scrapeJobs({
    sites: ["glassdoor"],
    title: "Frontend Engineer",
    stack: "React",
    count: 5,
    datePreset: "today",
  });
  assert.equal(sent[0].payload.searchTerm, "Frontend Engineer React");
  assert.equal(jobs.length, 1);
});

test("Jobright: title-only search, stack checked while paging so Count holds", async () => {
  const bodies = [];
  const publish = new Date(Date.now() - 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const item = (id, summary) => ({
    jobResult: {
      jobId: id,
      jobTitle: "Software Engineer",
      isRemote: true,
      publishTime: publish,
      jobSummary: summary,
      requirements: [],
      employmentType: "Full-time",
    },
    companyResult: { companyName: `Co ${id}` },
  });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const list = body.position === 0 ? [item("a", "Vue and Nuxt")] : body.position === 20 ? [item("b", "React and Redux")] : [];
    return { ok: true, status: 200, json: async () => ({ success: true, result: { jobList: list, jobNum: 40 } }) };
  };
  const { jobs, errors } = await scrapeJobs({
    sites: ["jobright"],
    title: "Software Engineer",
    stack: "React",
    count: 1,
    datePreset: "today",
  });
  assert.deepEqual(errors, []);
  assert.equal(bodies[0].value, "Software Engineer", "job-title search gets the title only");
  assert.deepEqual(jobs.map((j) => j.company), ["Co b"]);
  assert.equal(bodies.length, 2, "paged past the non-React job, then stopped at Count");
});

test("Jobright: jobs whose original post is on LinkedIn are left out", async () => {
  const publish = new Date(Date.now() - 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const item = (id, extra = {}, company = {}) => ({
    jobResult: { jobId: id, jobTitle: "Software Engineer", isRemote: true, publishTime: publish, jobSummary: "Build APIs.", requirements: [], ...extra },
    companyResult: { companyName: `Co ${id}`, ...company },
  });
  const list = [
    item("a", { applyLink: "https://www.linkedin.com/jobs/view/4012345678/" }),
    item("b", { applyLink: "https://boards.greenhouse.io/acme/jobs/1" }),
    item("c", { applyLink: "https://acme.example/careers/2" }, { companyLinkedinURL: "https://www.linkedin.com/company/acme" }),
    item("d", { applyLink: "https://jobs.lever.co/acme/3", jobSummary: "Apply on LinkedIn or our site." }),
    item("e", { source: { originalUrl: "https://lnkd.in/gAbCdEf" } }),
  ];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ success: true, result: { jobList: body.position === 0 ? list : [], jobNum: list.length } }) };
  };
  const progress = [];
  const { jobs } = await scrapeJobs({ sites: ["jobright"], title: "Software Engineer", count: 10, onProgress: (m) => progress.push(m) });
  assert.deepEqual(jobs.map((j) => j.company), ["Co b", "Co c", "Co d"]);
  assert.ok(progress.some((m) => /2 leading to LinkedIn left out/.test(m)), progress.join("\n"));
  assert.ok(!progress.some((m) => /had no original links/.test(m)));
});

test("Jobright: when no job carries its original link, the log says so", async () => {
  const publish = new Date(Date.now() - 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const list = body.position === 0
      ? [{ jobResult: { jobId: "x", jobTitle: "Software Engineer", isRemote: true, publishTime: publish }, companyResult: { companyName: "Co x" } }]
      : [];
    return { ok: true, status: 200, json: async () => ({ success: true, result: { jobList: list, jobNum: 1 } }) };
  };
  const progress = [];
  const { jobs } = await scrapeJobs({ sites: ["jobright"], title: "Software Engineer", count: 10, onProgress: (m) => progress.push(m) });
  assert.equal(jobs.length, 1);
  assert.ok(progress.some((m) => /had no original links/.test(m)), progress.join("\n"));
});
