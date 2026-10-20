import { scrapeJobs } from "./scrapers/index.js";
import { resolveDatePreset } from "./scrapers/util.js";

const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");

function setStatus(message, kind = "") {
  statusEl.textContent = message || "";
  statusEl.className = "status" + (kind ? ` ${kind}` : "");
}

function log(line) {
  logEl.hidden = false;
  logEl.textContent += (logEl.textContent ? "\n" : "") + line;
}

function downloadExcel(jobs) {
  if (typeof XLSX === "undefined") {
    throw new Error("Excel library failed to load");
  }

  const rows = jobs.map((j) => ({
    Title: j.title ?? "",
    Company: j.company ?? "",
    Location: j.location ?? "",
    Site: j.site ?? "",
    Posted: j.date_posted ?? "",
    Remote: j.is_remote ?? "",
    "Easy Apply": j.easy_apply ?? "",
    "Listing type": j.listing_type ?? "",
    "Experience years":
      j.years_required == null || j.years_required === ""
        ? ""
        : j.years_required,
    "Job URL": j.job_url ?? "",
    "Direct URL": j.job_url_direct ?? "",
  }));

  const sheet = XLSX.utils.json_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Jobs");

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  XLSX.writeFile(book, `jobbridge-remote-us-${stamp}.xlsx`);
}

async function run() {
  const { pendingFetch } = await chrome.storage.local.get("pendingFetch");
  if (!pendingFetch) {
    setStatus("No pending fetch. Open the extension popup and press OK.", "error");
    return;
  }

  const { title, stack, count, sites, datePreset, years, jobType } = pendingFetch;
  await chrome.storage.local.remove("pendingFetch");

  const preset = resolveDatePreset(datePreset);

  const typeLabel = jobType === "contract" ? "Contract" : "Full time";
  const yearsLabel =
    years === "" || years == null
      ? "—"
      : `${years} (keep jobs asking for ${Number(years) + 0.5} years or fewer)`;
  log(
    `Platforms: ${sites.join(", ")}\nCount (per site): ${count}\nPosted: ${preset.label}\nType: ${typeLabel}\nYears: ${yearsLabel}\nTitle: ${title || "—"}\nStack: ${stack || "—"}\nFilters: remote · US`
  );
  setStatus("Fetching remote US jobs from selected platforms…");

  try {
    const { jobs, errors } = await scrapeJobs({
      sites,
      title,
      stack,
      count,
      datePreset: preset.id,
      years: years === "" || years == null ? "" : Number(years),
      jobType: jobType === "contract" ? "contract" : "fulltime",
      onProgress: (msg) => log(msg),
    });

    if (errors.length) {
      log(`Warnings:\n- ${errors.join("\n- ")}`);
    }

    if (!jobs.length) {
      setStatus(
        errors.length
          ? "No jobs found. See log for platform errors."
          : "No jobs found for those filters.",
        "error"
      );
      return;
    }

    downloadExcel(jobs);
    setStatus(`Downloaded ${jobs.length} job(s) as Excel.`, "success");
    log(`Done — ${jobs.length} rows written to .xlsx`);
  } catch (err) {
    const msg = err?.message || String(err);
    setStatus(msg, "error");
    log(msg);
  }
}

run();
