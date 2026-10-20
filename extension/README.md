# JobBridge Chrome Extension

Standalone extension — **no `web.app` / Flask server required**.

Fetches **remote-only US** jobs by calling the same public APIs / HTML endpoints JobSpy uses, then downloads an Excel (`.xlsx`) file.

## Platforms

| Option | How it fetches |
|--------|----------------|
| LinkedIn | Guest search cards — remote (`f_WT=2`) + US only (no Easy Apply search / no detail pages) |
| Indeed | GraphQL `apis.indeed.com` — remote attribute `DSQF7` |
| Wellfound | `POST api.orgupdate.com/search-jobs-v1` |
| Glassdoor | GraphQL via a real `glassdoor.com` tab (Cloudflare bypass) |
| ZipRecruiter | Tab scrape of `ziprecruiter.com` jobs-search HTML |
| Jobright | `swan-api.jobright.ai` visitor-search (the API behind the site's job-title search) — `workModel` Remote, `daysAgo` 1/3, `jobTypes` full-time or contract; empty title falls back to a `/remote-jobs` tab. The sheet links to the Jobright job page |
| Dice | Tab scrape of `dice.com/jobs` — Next.js RSC `jobList` (remote + posted date filters) |

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this `extension/` folder
4. Pin **JobBridge Fetch** → set platforms / count / type / years / title / stack → **OK**
5. Keep the fetch tab open until the Excel download finishes

If you already had the extension loaded, click **Reload** on the card after updates.

## Popup fields

- **Platforms** — multi-select
- **Count** — max results **per platform** (1–200)
- **Posted** — **Today** (last 24h) or **3 days** (last 72h); applied on each board’s date filter
- **Type** — **Full time** or **Contract**. Each board is queried with that type. A job that clearly says the other type is dropped. Jobs that never say a type stay.
- **Years** — optional. Enter `5` to keep jobs whose posting asks for **5.5 years or fewer** (`5+ years of experience`, `3-5 years experience`, and the same shapes). The highest stated requirement is used. Jobs that don’t mention years stay. No language model is used.
- **Title** / **Stack** — search keywords (stack also filters title/description; the description is not written to the sheet)
- **OK** — opens a runner tab that scrapes in-browser and saves `.xlsx`

## Notes

- Boards may rate-limit or change HTML/APIs; failed platforms are listed in the runner log while others still export.
- **403 fixes:** the extension installs `declarativeNetRequest` header rules so Indeed gets the mobile Indeed App User-Agent, and Glassdoor/Wellfound get a normal browser Origin (not `chrome-extension://`). After updating, click **Reload** on the extension card (needed once so the background worker installs rules).
- **Glassdoor / ZipRecruiter / Jobright / Dice Cloudflare:** scrape runs inside a real site tab. If a security page appears, complete it there and press OK again.
- Title words must appear in the **job title** on every platform (whole words; `Sr` = `Senior`, `Front-End` = `Frontend`, `engineer` also matches `engineering`). Boards' keyword search also matches descriptions, so each scraper keeps paging until it has **Count** title matches or the board runs out. Stack tokens may match title or description.
- Excel is built with SheetJS (`lib/xlsx.mini.min.js`).
