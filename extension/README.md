# JobBridge Chrome Extension

Standalone extension — **no `web.app` / Flask server required**.

Fetches **remote jobs open to the US** from job boards' public APIs, feeds and pages, then downloads an Excel (`.xlsx`) file.

## Platforms

| Option | How it fetches |
|--------|----------------|
| LinkedIn | Guest search cards — remote (`f_WT=2`) + US only (no Easy Apply search / no detail pages) |
| Indeed | GraphQL `apis.indeed.com` — remote attribute `DSQF7` |
| Wellfound | Tab scrape of `wellfound.com/role/r/<role>` (remote jobs for the Wellfound role your **Title** names, e.g. `Senior React Frontend Engineer` → `frontend-engineer`, looked up in Wellfound's role list; every remote role at `/remote` when the title isn't one), read from the page's `__NEXT_DATA__`. Keeps jobs open to remote workers in the US: US-wide, a US state or city, North America, or no limit. On-site jobs are dropped. At most 15 pages per run. Wellfound has almost no contract listings, and its listings aren't sorted by date, many being weeks old, so **3 days** finds more than **Today** |
| Glassdoor | GraphQL via a real `glassdoor.com` tab (Cloudflare bypass) |
| ZipRecruiter | Tab scrape of `ziprecruiter.com` jobs-search HTML (only a `ziprecruiter.com` tab is reused, never a regional one) |
| Jobright | `swan-api.jobright.ai` visitor-search (the API behind the site's job-title search) — `workModel` Remote, `daysAgo` 1/3, `jobTypes` full-time or contract; empty title falls back to a `/remote-jobs` tab. The sheet links to the Jobright job page |
| Dice | Tab scrape of `dice.com/jobs` — Next.js RSC `jobList` (remote + posted date filters) |
| Himalayas | Free public API `himalayas.app/jobs/api/search` (`country=US`, newest first, full-time/contractor filter; up to 10 pages for **Today**, 20 for **3 days**). Remote-only board; keeps US and worldwide jobs. The API is reported to refuse browser user agents, so a header rule names the extension (`JobBridgeFetch/1.12`) on its own API calls. Himalayas caches results for up to a day. Terms: credit Himalayas and link to its job page (the sheet does both) |
| Jobicy | Free public API `jobicy.com/api/jobs` (`geo=usa` plus `geo=anywhere`; covers about the last 7 days), newest pages filtered here — Jobicy's own search is a raw substring match ("rust" finds "trust") that misses title synonyms. Remote-only board. Listings appear a few hours after their date, and Jobicy re-publishes older listings with a fresh date. Terms: credit Jobicy, link to its job page (the sheet does both), and don't poll more than once an hour |
| Jobspresso | Public RSS feed `jobspresso.co/jobs/feed/` — the 20 newest jobs, filtered here (its robots.txt allows only that path, so there is no server-side search). Remote-only, hand-checked board that posts in batches (nothing new from 29 Aug to at least 9 Oct 2026), so short windows are often empty; the log names the newest posting. The feed has no job type |
| Built In | Tab scrape of `builtin.com/jobs/remote` (`country=USA`, `daysSinceUpdated` 1/3), one page every 2 seconds. Keeps jobs whose badge allows remote ("Remote", "Remote or Hybrid", "In-Office or Remote") located in the US. Cards have no job type, and "Reposted" cards carry the repost date. **Built In's terms of use forbid automated access and its robots.txt disallows search URLs — use at your own discretion** |
| Work at a Startup | Y Combinator's board, read in a `workatastartup.com` tab through the site's own Algolia search, newest first. **Needs a free YC account and you signed in** (signed out, the board finds nothing and says so); unticked by default. **YC's terms of use forbid scraping — use at your own discretion** |
| HN Who's hiring | The newest "Ask HN: Who is hiring?" thread via the public HN Algolia API. Each top-level comment is one post; its first line (`Company \| Role \| Location \| REMOTE \| …`) gives the company and the title (the part matching your **Title**). Remote and US are judged on that first line (bodies of on-site posts often say "global"): kept when it says remote and names a US-friendly region (US, a US state, North America, Americas, PT/ET, worldwide…) or no region at all; dropped when it names only non-US places. "Multiple roles" posts take the title from a role line in the body. Job-seeker posts are skipped. Dated by the comment: threads go up on the first weekday of the month and most posts land in the first 1–3 days, so **Today** later in the month finds few; early in the month last month's thread is read too |
| Turing | `work.turing.com` — its job board's own API (one call returns the whole board; falls back to a `work.turing.com` tab if blocked). Every role is **contract** work (many are AI-training gigs), so **Type = Full time** finds none; unticked by default. Jobs have no country field, so only explicit non-US wording drops a job. The API is undocumented and was last confirmed by a third party in July 2026; Turing's terms may forbid scraping (not confirmed) — use at your own discretion |

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this `extension/` folder
4. Pin **JobBridge Fetch** → set platforms / count / type / years / title / stack → **OK**
5. Keep the fetch tab open until the Excel download finishes

If you already had the extension loaded, click **Reload** on the card after updates.

## Popup fields

- **Platforms** — multi-select (**All** / **None**). Boards added in an update start ticked, even if you saved your choices before.
- **Count** — max results **per platform** (1–200)
- **Posted** — **Today** (last 24h) or **3 days** (last 72h); applied on each board’s date filter
- **Type** — **Full time** or **Contract**. Boards with a type filter are queried with it (Wellfound, Jobicy, Jobspresso, Built In and HN have none, so they are filtered here; Turing is contract only). A job that clearly says the other type is dropped. Jobs that never say a type stay. Titles like `Contract Manager` or `Smart Contracts Engineer` are jobs about contracts, not contract jobs.
- **Years** — optional. Enter `5` to keep jobs whose posting asks for **5.5 years or fewer** (`5+ years of experience`, `3-5 years experience`, `5 or more years of experience`, `Experience: 5+ years`, and the same shapes). The highest stated requirement is used. Company blurbs are ignored (`we have 15 years of experience`, `12 years of combined experience across our leadership`, anything above 15 years). Jobs that don’t mention years stay. No language model is used.
- **Title** / **Stack** — keywords. LinkedIn, Indeed, ZipRecruiter, Dice, Glassdoor and Built In search title + stack, so boards whose results carry little or no description match the stack against the whole posting on their side. Jobright, Himalayas, Work at a Startup and Wellfound search the title only (or browse the title's role page), and Jobicy, Jobspresso, HN and Turing are read whole; those boards, plus Indeed, check each stack word against the description as a whole word (`Go` ≠ `Google`, `Java` ≠ `JavaScript`, `Next.js` ≠ "next", `Node.js` = `NodeJS`, `Python` matches `Python3`). The description is not written to the sheet.
- **OK** — opens a runner tab that scrapes in-browser and saves `.xlsx`

## Notes

- Boards may rate-limit or change HTML/APIs; failed platforms are listed in the runner log while others still export. A board that stops partway (blocked, timed out) keeps what it found and says "stopped early" in the log.
- **403 fixes:** the extension installs `declarativeNetRequest` header rules so its own Indeed API requests get the mobile Indeed App User-Agent and its Jobright API requests get a `jobright.ai` Origin, and its Himalayas API requests name the extension instead of a browser. The rules skip requests made by those sites' own pages, so your normal browsing is untouched. Boards scraped in a site tab get no header changes. After updating, click **Reload** on the extension card (needed once so the rules install).
- **Site tabs (Glassdoor / ZipRecruiter / Jobright / Dice / Wellfound / Built In / Work at a Startup, and Turing when blocked):** the scrape runs inside a real site tab. A tab you already have open on that site is used as it is and never navigated away; otherwise a new tab opens. If the site blocks the scrape (for example an expired security-check cookie) or your tab can't run it (error page, crashed or still loading), the scrape is retried once in a new tab, where any security check is shown. Complete it there and press OK again.
- Title words must appear in the **job title** on every platform (whole words; `Sr` = `Senior`, `Front-End` = `Frontend`, `engineer` also matches `engineering`). Boards' keyword search also matches descriptions, so each scraper keeps paging until it has **Count** jobs that pass every filter (title, stack, years, type, date) or the board runs out. Indeed, Himalayas, Jobicy and Work at a Startup stop once a page is older than the **Posted** window.
- Excel is built with SheetJS (`lib/xlsx.mini.min.js`). Job URL and Direct URL cells are clickable links.
- Tests: `npm test` from the repository root (Node 20+, no install needed).
