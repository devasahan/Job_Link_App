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
];

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
  if (saved.job_type === "fulltime" || saved.job_type === "contract") {
    form.job_type.value = saved.job_type;
  }
  if (saved.years != null && saved.years !== "") {
    form.years.value = String(saved.years);
  }
  if (Array.isArray(saved.sites) && saved.sites.length) {
    form.querySelectorAll('input[name="site"]').forEach((el) => {
      el.checked = saved.sites.includes(el.value);
    });
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const title = form.title.value.trim();
  const stack = form.stack.value.trim();
  const count = Math.max(1, Math.min(200, Number(form.count.value) || 50));
  const datePreset =
    form.date_preset.value === "3days" ? "3days" : "today";
  const jobType = form.job_type.value === "contract" ? "contract" : "fulltime";
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
    pendingFetch: { title, stack, count, sites, datePreset, years, jobType },
  });

  await chrome.tabs.create({
    url: chrome.runtime.getURL("runner.html"),
  });

  window.close();
});

restoreForm();
