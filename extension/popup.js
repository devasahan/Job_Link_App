import { downloadedCount, forgetDownloaded } from "./scrapers/history.js";

const form = document.getElementById("fetch-form");
const statusEl = document.getElementById("status");
const okBtn = document.getElementById("ok-btn");

const STORAGE_KEYS = [
  "title",
  "stack",
  "count",
  "sites",
  "date_preset",
  "years",
  "job_type",
  "known_sites",
  "skip_downloaded",
];

// Boards the popup had before known_sites was saved
const FIRST_SITES = ["linkedin", "indeed", "wellfound", "glassdoor", "zip_recruiter", "jobright", "dice"];

const siteBoxes = () => [...form.querySelectorAll('input[name="site"]')];

function setStatus(message, kind = "") {
  statusEl.textContent = message || "";
  statusEl.className = "status" + (kind ? ` ${kind}` : "");
}

function selectedSites() {
  return [...form.querySelectorAll('input[name="site"]:checked')].map(
    (el) => el.value
  );
}

async function restoreForm() {
  const saved = await chrome.storage.local.get(STORAGE_KEYS);
  if (saved.title) form.title.value = saved.title;
  if (saved.stack) form.stack.value = saved.stack;
  if (saved.count) form.count.value = String(saved.count);
  if (saved.date_preset === "today" || saved.date_preset === "3days") {
    form.date_preset.value = saved.date_preset;
  }
  if (["fulltime", "contract", "both"].includes(saved.job_type)) {
    form.job_type.value = saved.job_type;
  }
  if (saved.years != null && saved.years !== "") {
    form.years.value = String(saved.years);
  }
  form.skip_downloaded.checked = saved.skip_downloaded !== false;
  if (Array.isArray(saved.sites) && saved.sites.length) {
    const known = Array.isArray(saved.known_sites) ? saved.known_sites : FIRST_SITES;
    // Boards added since the last save keep their default (ticked)
    siteBoxes().forEach((el) => {
      if (known.includes(el.value)) el.checked = saved.sites.includes(el.value);
    });
  }
}

const countEl = document.getElementById("downloaded-count");
const forgetBtn = document.getElementById("forget-btn");

async function showDownloaded() {
  const n = await downloadedCount();
  countEl.textContent = n ? `(${n} remembered)` : "";
  forgetBtn.hidden = !n;
}

forgetBtn.addEventListener("click", async () => {
  await forgetDownloaded();
  await showDownloaded();
  setStatus("Forgot downloaded jobs: the next run includes them again.");
});

form.querySelectorAll("[data-pick]").forEach((button) => {
  button.addEventListener("click", () => {
    const all = button.dataset.pick === "all";
    siteBoxes().forEach((el) => {
      el.checked = all;
    });
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const title = form.title.value.trim();
  const stack = form.stack.value.trim();
  const count = Math.max(1, Math.min(200, Number(form.count.value) || 50));
  const datePreset =
    form.date_preset.value === "3days" ? "3days" : "today";
  const jobType = ["contract", "both"].includes(form.job_type.value) ? form.job_type.value : "fulltime";
  const yearsRaw = form.years.value.trim();
  let years = "";
  if (yearsRaw !== "") {
    years = Number(yearsRaw);
    if (!Number.isFinite(years) || years < 0 || years > 40) {
      setStatus("Years must be a number from 0 to 40.", "error");
      return;
    }
  }
  const sites = selectedSites();
  const skipDownloaded = form.skip_downloaded.checked;

  if (!sites.length) {
    setStatus("Select at least one platform.", "error");
    return;
  }

  okBtn.disabled = true;
  setStatus("Opening fetch tab…");

  await chrome.storage.local.set({
    title,
    stack,
    count,
    sites,
    date_preset: datePreset,
    years,
    job_type: jobType,
    known_sites: siteBoxes().map((el) => el.value),
    skip_downloaded: skipDownloaded,
    pendingFetch: { title, stack, count, sites, datePreset, years, jobType, skipDownloaded },
  });

  await chrome.tabs.create({
    url: chrome.runtime.getURL("runner.html"),
  });

  window.close();
});

restoreForm();
showDownloaded();
