import fetch from "node-fetch";
import fs from "fs";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";
import { validateAndGetCompany } from "./company.js";
import { querySOLR, upsertJobs, upsertCompany, deleteJobByUrl } from "./api.js";
import { generateJobsMarkdown } from "./markdown-generator.js";
import { filterValidJobs, assertScrapeYieldedJobs } from "./validate.js";
import { validateByContent } from "./job-validator.js";
import { getHtml } from "./browser.js";
import { locateArticles, firstMatch, regexText, textFromHtml } from "./self-healing.js";
import companyConfig from "./config/company.js";
import scraperConfig, { userAgent } from "./config/scraper.js";

const COMPANY_CIF = companyConfig.id;

const TIMEOUT = scraperConfig.requestTimeoutMs;
const PAGE_DELAY = scraperConfig.pageDelayMs;
const OWN_URL_PREFIX = scraperConfig.ownJobUrlPrefix;

// The path segment that marks an individual job permalink, derived from
// `ownJobUrlPrefix` (e.g. "https://site.com/jobs/" -> "/jobs/"). Used to pick
// job URLs out of the sitemap. Falls back to matching any prefixed URL.
const JOB_PATH = (() => {
  try { return new URL(OWN_URL_PREFIX).pathname.replace(/\/+$/, "") + "/"; }
  catch { return "/"; }
})();

// A short label for where a scraped job came from (the careers host).
const CAREERS_SOURCE = (() => {
  try { return new URL(scraperConfig.sources.listing).host; }
  catch { return "careers-site"; }
})();

let COMPANY_NAME = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isOwnJob = (url) => typeof url === "string" && url.startsWith(OWN_URL_PREFIX);

// ============================================================================
// Slug helpers — join listing titles to canonical job permalinks
// ============================================================================

// Romanian diacritics have no NFD decomposition for ș/ț, so map them explicitly.
const DIACRITICS = {
  "ă": "a", "â": "a", "î": "i",
  "ș": "s", "ş": "s", "ț": "t", "ţ": "t"
};

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[ăâîșşțţ]/g, (c) => DIACRITICS[c] || c)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

// Exact-slug match only. Split out from matchSitemapUrl below so callers can
// run an exact-only pass over every item before any of them is allowed to
// fall back to a fuzzy match -- see the ordering note in scrapeCareers.
function matchSitemapUrlExact(title, sitemapEntries) {
  const slug = slugify(title);
  const exact = sitemapEntries.find((e) => e.slug === slug);
  return exact ? exact.url : null;
}

// Pick the sitemap URL whose slug best matches a listing title. Sitemaps drift
// in the real world (typos, a "-2" disambiguation suffix), so match
// exact → bounded prefix → small edit distance, else return null.
function matchSitemapUrl(title, sitemapEntries) {
  const slug = slugify(title);
  const exact = sitemapEntries.find((e) => e.slug === slug);
  if (exact) return exact.url;

  // Tolerate a trailing "-2"/"-copy" style disambiguation suffix on either side,
  // but only at a "-" boundary so "manager" can't swallow "manager-portofoliu".
  const boundedPrefix = (a, b) => a === b || (a.startsWith(b) && a[b.length] === "-");
  const prefix = sitemapEntries.find(
    (e) => boundedPrefix(e.slug, slug) || boundedPrefix(slug, e.slug)
  );
  if (prefix) return prefix.url;

  let best = null, bestDist = Infinity;
  for (const e of sitemapEntries) {
    const dist = levenshtein(slug, e.slug);
    if (dist < bestDist) { bestDist = dist; best = e; }
  }
  return bestDist <= 2 ? best.url : null;
}

// "30.09.2026" -> "2026-09-30T23:59:59.000Z" (end of the closing day).
// Also accepts an ISO date (schema.org JobPosting `validThrough`).
function parseDeadline(text) {
  if (!text) return undefined;
  const s = String(text);

  const dmy = s.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    const d = new Date(Date.UTC(+yyyy, +mm - 1, +dd, 23, 59, 59));
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }

  const iso = s.match(/\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?/);
  if (iso) {
    const d = new Date(iso[0]);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }

  return undefined;
}

// ============================================================================
// Careers listing — the company's own site (config `sources`)
// ============================================================================

async function fetchSitemapJobUrls() {
  const sitemapUrl = scraperConfig.sources.sitemap;
  if (!sitemapUrl || sitemapUrl.startsWith("{{")) return []; // not configured
  try {
    const res = await fetch(sitemapUrl, {
      timeout: TIMEOUT,
      headers: { "User-Agent": userAgent }
    });
    if (!res.ok) {
      console.log(`  Sitemap returned ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const entries = [];
    // one path segment past JOB_PATH, e.g. /jobs/<slug>/ but not the /jobs/ index
    const jobUrlRe = new RegExp(`${JOB_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^/]+/?$`);
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      const url = m[1].trim();
      if (!jobUrlRe.test(url)) continue;
      const slug = url.replace(/\/$/, "").split("/").pop();
      entries.push({ url, slug });
    }
    console.log(`  Sitemap: ${entries.length} job permalinks`);
    return entries;
  } catch (err) {
    console.log(`  Sitemap error: ${err.message}`);
    return [];
  }
}

async function fetchListing() {
  // static fetch by default; rendering.mode in scraper.json switches to a headless browser
  return getHtml(scraperConfig.sources.listing, { parseOk: (html) => parseListing(html).length > 0 });
}

// Strip HTML tags / collapse whitespace, cap at the job-model title limit.
function cleanTitle(raw) {
  const t = textFromHtml(raw);
  if (!t) return null;
  return t.replace(/\s+/g, " ").trim().slice(0, 200) || null;
}

/**
 * Parse the open-positions listing into { title, expirationdate, url } items,
 * self-healing through the selector cascade (default: scraper/config/scraper.json;
 * pass `selectors` explicitly in tests):
 *
 *   article blocks:  CSS list  ->  JSON-LD JobPosting  ->  regex <article>
 *   title:           CSS list  ->  regex <hN>  ->  regex <a>
 *   deadline:        CSS list  ->  date regex over the whole block text
 *   url:             first real <a href> in the block (may be relative; the
 *                     caller resolves it against the listing page)
 *
 * `url` is null when the block has no anchor at all -- the caller then falls
 * back to a sitemap match or a title-slug guess. Prefer this scraped `url`
 * whenever present: guessing a permalink from the title alone breaks on any
 * site whose real URL needs an ID the title can't reproduce.
 *
 * @param {string} html
 * @param {{jobArticle:any, jobTitle:any, jobMeta:any, jobUrl?:any}} [selectors]
 */
function parseListing(html, selectors = scraperConfig.selectors) {
  const { jobTitle, jobMeta, jobArticle, jobUrl } = selectors;
  const { mode, scopes, jsonLd } = locateArticles(html, jobArticle);
  const items = [];
  const strategies = new Set();
  // Dedup key is title+URL, not title alone: a broad fallback selector can
  // match the same block twice (same title AND same URL), but a site is
  // free to post one title open in several locations, each with its own
  // permalink (e.g. "Mecatronist" at both /sighisoara/ and /sovata/) -- that
  // is two real postings, not a selector artifact, and must not be dropped.
  const seenKeys = new Set();
  const dedupeKey = (title, url) => `${title.toLowerCase()}|${url || ""}`;

  if (mode === "jsonld") {
    for (const posting of jsonLd) {
      const title = cleanTitle(posting.title);
      const key = dedupeKey(title || "", posting.url);
      if (!title || seenKeys.has(key)) continue;
      seenKeys.add(key);
      strategies.add("jsonld");
      items.push({ title, expirationdate: parseDeadline(posting.validThrough), url: posting.url || null });
    }
    console.log(`  parseListing: ${items.length} items via JSON-LD JobPosting`);
    return items;
  }

  for (let i = 0; i < scopes.length; i++) {
    const scope = scopes[i];

    // TITLE — CSS cascade (incl. itemprop/aria hooks), then regex last resort.
    const { value: title, strategy } = firstMatch(`title[${i}]`, [
      { name: "css-cascade", run: () => scope.text(jobTitle).value },
      regexText(scope.raw(), /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i),
      regexText(scope.raw(), /<a\b[^>]*>([\s\S]*?)<\/a>/i)
    ], { silent: true });

    const cleaned = cleanTitle(title);
    if (!cleaned) continue;

    // DEADLINE — meta selectors, then a bare date regex over the whole block.
    const metaText = scope.text(jobMeta).value;
    const deadline = parseDeadline(metaText) || parseDeadline(scope.fullText());

    const url = scope.href(jobUrl).value;
    const key = dedupeKey(cleaned, url);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (strategy) strategies.add(strategy);

    items.push({ title: cleaned, expirationdate: deadline, url });
  }

  console.log(
    `  parseListing: ${items.length} items via ${mode}` +
    (strategies.size ? ` [${[...strategies].join(", ")}]` : "")
  );
  return items;
}

// Light location hint from the title; the transform step still validates against
// the Romanian-city allowlist and falls back to "România".
const RO_CITY_HINTS = [
  "Iași", "Iasi", "București", "Bucuresti", "Cluj", "Timișoara", "Timisoara",
  "Ploiești", "Ploiesti", "Constanța", "Constanta", "Brașov", "Brasov",
  "Craiova", "Sibiu", "Oradea", "Bacău", "Bacau", "Galați", "Galati",
  "Dâmbovița", "Dambovita"
];

function locationFromTitle(title) {
  const hit = RO_CITY_HINTS.find((c) => new RegExp(`\\b${c}\\b`, "i").test(title));
  return hit ? [hit] : scraperConfig.defaultLocation;
}

// ============================================================================
// iCIMS career portal (careers-arobs.icims.com)
// ============================================================================

// Normalised (lowercase, no diacritics, spaces -> "-") portal spelling -> canonical city.
const ICIMS_CITIES = Object.fromEntries([
  "Cluj-Napoca", "București", "Timișoara", "Iași", "Brașov", "Târgu Mureș", "Sibiu", "Oradea",
  "Arad", "Baia Mare", "Suceava", "Constanța", "Craiova", "Ploiești", "Pitești", "Galați", "Bacău"
].map((c) => [normCity(c), c]));
ICIMS_CITIES.bucharest = "București";

function normCity(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/\s+/g, "-");
}

// The portal writes "RO-Bucharest", "RO-Cluj Napoca" or "RO-<County>-<City>" (e.g.
// "RO-Timiș-Timisoara"). Match the longest dash-separated suffix that is a known
// city, so the county prefix is dropped but "Cluj-Napoca" itself stays whole.
function icimsCity(raw) {
  const parts = raw.replace(/^RO[- ]*/, "").split("-").map((p) => p.trim()).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const hit = ICIMS_CITIES[normCity(parts.slice(i).join("-"))];
    if (hit) return hit;
  }
  return parts.join("-");
}

// "RO-Cluj Napoca | RO-Bucharest" -> ["Cluj-Napoca", "București"]
function parseIcimsLocation(raw) {
  if (!raw || raw.trim() === "RO") return ["România"];
  const cities = raw.split("|").map((p) => icimsCity(p.trim())).filter(Boolean);
  const unique = [...new Set(cities)];
  return unique.length ? unique : ["România"];
}

function icimsSeniorityTag(seniority = "") {
  const s = seniority.toLowerCase();
  if (/senior|architect|lead|manager/.test(s)) return "senior";
  if (/junior/.test(s)) return "junior";
  if (/entry/.test(s)) return "entry-level";
  if (/intern|trainee/.test(s)) return "intern";
  if (/mid|intermediate/.test(s)) return "mid";
  return null;
}

const ICIMS_CATEGORY_TAGS = {
  "Development": ["it"],
  "Testing": ["qa"],
  "IT Special Roles": ["it"],
  "Administrative": ["administrative"],
  "Customer Service/Support": ["support"],
  "Human Resources": ["hr"],
  "Internship": ["intern"],
  "Management": ["management"],
  "Purchasing and Logistic": ["logistics"],
  "Sales": ["sales"],
  "Support": ["support"],
  "University Practice": ["intern", "student"]
};

const ICIMS_SKILL_PATTERNS = [
  ["it", /\b(java|kotlin|python|\.net|node\.?js|javascript|react|angular|frontend|programming|developer|software)\b/],
  ["embedded", /\b(embedded|c\+\+|rtos|firmware)\b/],
  ["data-science", /\b(data|analytics|big data|etl)\b/],
  ["ai", /\b(machine learning|ml|ai|mlops)\b/],
  ["devops", /\b(devops|ci\/cd|kubernetes|docker)\b/],
  ["cloud", /\b(cloud|azure|aws|gcp)\b/],
  ["automotive", /\b(automotive|autosar)\b/],
  ["iot", /\b(iot|internet of things)\b/],
  ["qa", /\b(qa|testing|test automation)\b/],
  ["security", /\b(security|cybersecurity)\b/],
  ["sap", /\b(sap|abap)\b/],
  ["aerospace", /\b(aerospace|avionics|do-178)\b/]
];

function icimsTags({ title, category, seniority }) {
  const tags = [];
  const sen = icimsSeniorityTag(seniority);
  if (sen) tags.push(sen);
  tags.push(...(ICIMS_CATEGORY_TAGS[category] || []));
  // Skills from the title only: the card description is marketing prose.
  const lower = String(title || "").toLowerCase();
  for (const [tag, re] of ICIMS_SKILL_PATTERNS) if (re.test(lower)) tags.push(tag);
  return [...new Set(tags)].slice(0, 20);
}

function icimsWorkmode(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  if (text.includes("remote")) return "remote";
  if (text.includes("hybrid")) return "hybrid";
  return scraperConfig.defaultWorkmode;
}

/** Parse one iCIMS search-results page into raw jobs + paging info. */
function parseIcimsPage(html, base = scraperConfig.sources.icims) {
  const $ = cheerio.load(html);
  const field = ($el, name) =>
    $el.find(".iCIMS_JobHeaderTag").filter((_, t) => $(t).find("dt.iCIMS_JobHeaderField").text().trim() === name)
      .find("dd span").text().trim();
  const jobs = [];

  $("li.iCIMS_JobCardItem").each((_, el) => {
    const $el = $(el);
    const title = decodeEntities($el.find(".title h3").text().replace(/\s+/g, " ").trim());
    const href = $el.find(".title a.iCIMS_Anchor").attr("href") || "";
    if (!title || !href) return;
    const url = new URL(href, base).toString().replace(/[?&]in_iframe=1$/, "");
    const category = field($el, "Category");
    const seniority = field($el, "Seniority");
    const description = $el.find(".description").text().trim();
    jobs.push({
      url,
      title,
      location: parseIcimsLocation($el.find(".header.left span").last().text().trim()),
      workmode: icimsWorkmode(title, description),
      tags: icimsTags({ title, category, seniority }),
      source: CAREERS_SOURCE
    });
  });

  const m = $("h2.iCIMS_SubHeader_Jobs").text().match(/Page\s+(\d+)\s+of\s+(\d+)/);
  return { jobs, currentPage: m ? Number(m[1]) : 1, totalPages: m ? Number(m[2]) : 1 };
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function scrapeIcims(maxPages = 50) {
  const all = [];
  const seen = new Set();
  for (let page = 0; page < maxPages; page++) {
    const url = page === 0 ? scraperConfig.sources.icims : `${scraperConfig.sources.icims}&pr=${page}`;
    console.log(`  Fetching ${url}`);
    const res = await fetch(url, { timeout: TIMEOUT, headers: { "User-Agent": userAgent, Accept: "text/html" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const { jobs, totalPages } = parseIcimsPage(await res.text());
    if (!jobs.length) break;
    let fresh = 0;
    for (const j of jobs) {
      if (!seen.has(j.url)) { seen.add(j.url); all.push(j); fresh++; }
    }
    console.log(`  Page ${page + 1}/${totalPages}: ${jobs.length} jobs, ${fresh} new (total ${all.length})`);
    if (page + 1 >= totalPages) break;
    await sleep(PAGE_DELAY);
  }
  return all;
}

async function scrapeCareers() {
  console.log(`Scraping ${scraperConfig.sources.listing} ...`);
  const jobs = [];

  if (scraperConfig.sources.icims) {
    // iCIMS career portal: paginated HTML with stable iCIMS_* class names. It is
    // authoritative - never fall back to the generic selectors, which are untuned
    // for this site (an empty result trips assertScrapeYieldedJobs instead).
    try {
      jobs.push(...(await scrapeIcims()));
    } catch (err) {
      console.log(`  iCIMS error: ${err.message}`);
    }
    console.log(`  Found ${jobs.length} jobs on ${CAREERS_SOURCE}`);
    return jobs;
  }

  const sitemapEntries = await fetchSitemapJobUrls();
  await sleep(PAGE_DELAY);

  let listingItems = [];
  try {
    listingItems = parseListing(await fetchListing());
    console.log(`  Listing: ${listingItems.length} open positions`);
  } catch (err) {
    console.log(`  Listing error: ${err.message}`);
  }

  if (listingItems.length > 0) {
    // Resolve every item's URL in two passes so an exact sitemap match
    // always wins a shared slug over a fuzzy one, regardless of which title
    // the listing happens to put first:
    //   pass 1 -- the scraped <a href> (ground truth) or an EXACT sitemap
    //             slug match; these are trustworthy, so claim their URLs
    //             immediately.
    //   pass 2 -- only the items pass 1 couldn't resolve try
    //             matchSitemapUrl's fuzzy fallback (bounded prefix, then
    //             small edit distance), and only win an unclaimed URL.
    // Without this ordering, a longer, unrelated title that fuzzy-matches an
    // earlier position in sitemapEntries could claim a sitemap URL before
    // the job that's an exact match for it even gets a turn -- e.g.
    // "Reprezentant Medical si Vanzari - Veterinare" (no sitemap entry of
    // its own, no anchor in the listing) grabbing "reprezentant-medical"
    // ahead of the real "Reprezentant Medical" posting. Two jobs sharing one
    // URL means one silently overwrites the other in SOLR.
    const resolvedUrls = new Array(listingItems.length);
    const claimedSitemapUrls = new Set();
    const unresolved = [];
    listingItems.forEach((item, i) => {
      // The real <a href> scraped from the page is ground truth -- prefer it
      // over guessing. Sites whose permalink needs an ID the title can't
      // reproduce (e.g. "/jobs/jr133930/software-architect/") silently 404
      // under the guess, which nothing else catches until the live
      // validation just before upload.
      if (item.url) {
        resolvedUrls[i] = new URL(item.url, scraperConfig.sources.listing).toString();
        return;
      }
      const exact = matchSitemapUrlExact(item.title, sitemapEntries);
      if (exact) {
        resolvedUrls[i] = exact;
        claimedSitemapUrls.add(exact);
      } else {
        unresolved.push(i);
      }
    });
    for (const i of unresolved) {
      const fuzzy = matchSitemapUrl(listingItems[i].title, sitemapEntries);
      if (fuzzy && !claimedSitemapUrls.has(fuzzy)) {
        resolvedUrls[i] = fuzzy;
        claimedSitemapUrls.add(fuzzy);
      } else {
        // Either no fuzzy match, or it points at a sitemap URL an exact
        // match already claimed this run -- guess instead. A wrong guess
        // 404s and dropDeadUrls removes it: a safe failure (job missing this
        // run) instead of an unsafe one (two jobs merged into one).
        resolvedUrls[i] = `${scraperConfig.sources.jobArchive}${slugify(listingItems[i].title)}/`;
      }
    }
    listingItems.forEach((item, i) => {
      const url = resolvedUrls[i];
      jobs.push({
        url,
        title: item.title,
        location: locationFromTitle(item.title),
        workmode: scraperConfig.defaultWorkmode,
        expirationdate: item.expirationdate,
        source: CAREERS_SOURCE
      });
    });
  } else if (sitemapEntries.length > 0) {
    // Listing unreachable — fall back to sitemap-only, deriving titles from slugs.
    console.log("  Falling back to sitemap-only (titles from slugs)");
    for (const e of sitemapEntries) {
      const title = e.slug
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
      jobs.push({
        url: e.url,
        title,
        location: scraperConfig.defaultLocation,
        workmode: scraperConfig.defaultWorkmode,
        source: CAREERS_SOURCE
      });
    }
  }

  console.log(`  Found ${jobs.length} jobs on ${CAREERS_SOURCE}`);
  return jobs;
}

// ============================================================================
// ANOFM — free public postings by CIF
// ============================================================================

async function searchANOFM(cif) {
  const jobs = [];
  try {
    console.log(`Searching ANOFM by CIF: ${cif}`);
    const payload = {
      current: 1,
      rowCount: 250,
      sort: { created_at: "desc" },
      employer_tax_code: cif
    };
    const res = await fetch("https://mediere.anofm.ro/api/entity/vw_public_job_posting", {
      method: "POST",
      timeout: TIMEOUT,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": userAgent
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.log(`  ANOFM returned ${res.status}`);
      return jobs;
    }
    const data = await res.json();
    for (const row of data.rows || []) {
      const locationParts = (row.address_locality_name || "").split(">").map((s) => s.trim());
      const location = locationParts.length > 1 ? locationParts[locationParts.length - 1] : locationParts[0];
      jobs.push({
        url: `https://mediere.anofm.ro/app/module/mediere/job/${row.id}`,
        title: row.occupation,
        location: location ? [location] : undefined,
        source: "ANOFM"
      });
    }
    console.log(`  Found ${jobs.length} jobs on ANOFM`);
  } catch (err) {
    console.log(`  ANOFM error: ${err.message}`);
  }
  return jobs;
}

// ============================================================================
// Job Model
// ============================================================================

function mapToJobModel(rawJob, cif, companyName = COMPANY_NAME) {
  const now = new Date().toISOString();

  const job = {
    url: rawJob.url,
    title: rawJob.title,
    company: companyName,
    cif: cif,
    location: rawJob.location?.length ? rawJob.location : undefined,
    tags: rawJob.tags?.length ? rawJob.tags : undefined,
    workmode: rawJob.workmode || undefined,
    expirationdate: rawJob.expirationdate || undefined,
    date: now,
    status: "scraped"
  };

  Object.keys(job).forEach((k) => job[k] === undefined && delete job[k]);

  return job;
}

function transformJobsForSOLR(payload) {
  const romanianCities = [
    'Bucharest', 'București', 'Bucuresti', 'Cluj-Napoca', 'Cluj Napoca',
    'Timișoara', 'Timisoara', 'Iași', 'Iasi', 'Brașov', 'Brasov',
    'Constanța', 'Constanta', 'Craiova', 'Bacău', 'Sibiu',
    'Târgu Mureș', 'Targu Mures', 'Oradea', 'Baia Mare', 'Satu Mare',
    'Ploiești', 'Ploiesti', 'Pitești', 'Pitesti', 'Arad', 'Galați', 'Galati',
    'Brăila', 'Braila', 'Drobeta-Turnu Severin', 'Râmnicu Vâlcea', 'Ramnicu Valcea',
    'Buzău', 'Buzau', 'Botoșani', 'Botosani', 'Zalău', 'Zalau', 'Hunedoara', 'Deva',
    'Suceava', 'Bistrița', 'Bistrita', 'Tulcea', 'Călărași', 'Calarasi',
    'Giurgiu', 'Alba Iulia', 'Slatina', 'Piatra Neamț', 'Piatra Neamt', 'Roman',
    'Dumbrăvița', 'Dumbravita', 'Voluntari', 'Popești-Leordeni', 'Popesti-Leordeni',
    'Chitila', 'Mogoșoaia', 'Mogosoaia', 'Otopeni', 'Dâmbovița', 'Dambovita',
    'Sighișoara', 'Sighisoara', 'Sovata', 'Reghin', 'Târnăveni', 'Tarnaveni'
  ];

  const citySet = new Set(romanianCities.map(c => c.toLowerCase()));

  const normalizeWorkmode = (wm) => {
    if (!wm) return undefined;
    const lower = wm.toLowerCase();
    if (lower.includes('remote')) return 'remote';
    if (lower.includes('office') || lower.includes('on-site') || lower.includes('site')) return 'on-site';
    return 'hybrid';
  };

  const transformed = {
    ...payload,
    company: payload.company?.toUpperCase(),
    jobs: payload.jobs.map(job => {
      const validLocations = (job.location || []).filter(loc => {
        const lower = loc.toLowerCase().trim();
        if (lower === 'romania' || lower === 'românia') return true;
        return citySet.has(lower);
      }).map(loc => loc.toLowerCase() === 'romania' ? 'România' : loc);

      return {
        ...job,
        location: validLocations.length > 0 ? validLocations : ['România'],
        workmode: normalizeWorkmode(job.workmode)
      };
    })
  };

  return transformed;
}

/**
 * Pre-upload safety net: GET-check every job URL and drop the ones that don't
 * resolve. filterValidJobs only checks URL *shape* (a syntactically valid
 * http(s) URL); job-validator.js can actually tell a live job from a 404, but
 * nothing called it before an upload -- this is what let a URL-construction
 * bug reach peviitor undetected.
 *
 * Uses validateByContent (GET), not validateByHead: at least one real
 * careers site (Workday-based) answers every HEAD request with a generic 404
 * regardless of whether the resource exists -- HEAD-only would have dropped
 * every real job.
 */
async function dropDeadUrls(jobs) {
  const alive = [];
  for (const job of jobs) {
    const result = await validateByContent(job.url);
    if (result.status === "active") {
      alive.push(job);
    } else {
      console.warn(`  dropped "${job.title}" (${job.url}): live URL check failed — ${result.error || `HTTP ${result.httpStatus}`}`);
    }
  }
  if (alive.length < jobs.length) {
    console.warn(`  ${jobs.length - alive.length}/${jobs.length} job(s) failed live URL validation and were dropped`);
  }
  return alive;
}

// ============================================================================
// MAIN
// ============================================================================

/**
 * `--dry-run` mirrors the Python template's `--dry-run` flag: scrape and
 * validate normally, but make zero real writes -- no company upsert, no job
 * upsert, no job delete of any kind. This flag did not exist at all before
 * (this whole function always wrote for real, unconditionally, including a
 * CIF-wide job delete for an ANAF-inactive company), so every "test run" of
 * a JS scraper was a real production write.
 */
async function main(dryRun = process.argv.includes("--dry-run")) {
  try {
    fs.mkdirSync("scraper", { recursive: true });

    console.log("=== Step 1: Get existing jobs from SOLR ===");
    const existingResult = await querySOLR(COMPANY_CIF);
    const existingCount = existingResult.numFound;
    // Every URL under this CIF (used to classify a scraped job as new vs. update).
    const allExistingUrls = new Set(existingResult.docs.map(d => d.url));
    // Only URLs this scraper owns — the same CIF may also carry jobs published
    // by other peviitor scrapers / aggregators. We never touch those, and only
    // these can be reported as "gone from the site".
    const ownExistingUrls = new Set(
      existingResult.docs.map(d => d.url).filter(isOwnJob)
    );
    console.log(`Found ${existingCount} existing jobs in SOLR (${ownExistingUrls.size} ours)`);

    console.log("=== Step 2: Validate company via ANAF ===");
    const { company, cif, address, status } = await validateAndGetCompany(dryRun);
    COMPANY_NAME = company;
    if (status === 'inactive') {
      if (dryRun) {
        console.log(`Company is INACTIVE — dry-run, so NOT deleting our ${ownExistingUrls.size} job(s) (would delete on a real run; validateAndGetCompany already skipped the CIF-wide delete)`);
      } else {
        console.log("Company is INACTIVE — removing only our own jobs, skipping scrape.");
        for (const url of ownExistingUrls) {
          try { await deleteJobByUrl(url); } catch (e) { console.warn(`  delete failed: ${url} — ${e.message}`); }
        }
      }
      return;
    }

    // On by default: upsertCompany is an idempotent PUT of ANAF-validated facts
    // (name, address, website, career URL), so there's no real downside to
    // keeping the company core in sync -- unlike staleJobDeletion below, this
    // is additive, not destructive. Only turn it off once you've verified
    // another scraper genuinely owns this CIF's company record.
    if (scraperConfig.manageCompany && !dryRun) {
      try {
        await upsertCompany({
          id: cif,
          company,
          brand: companyConfig.brand || undefined,
          status: status === 'active' ? 'activ' : (status || "activ"),
          location: address ? [address] : companyConfig.location,
          website: companyConfig.website,
          career: companyConfig.career,
          scraperFile: companyConfig.scraperFile,
          lastScraped: new Date().toISOString().split('T')[0]
        });
      } catch (err) {
        console.log(`Note: Could not upsert company: ${err.message}`);
      }
    } else if (dryRun && scraperConfig.manageCompany) {
      console.log(`Dry-run — would upsert company core for CIF ${cif}`);
    } else {
      console.log(
        "manageCompany=false — leaving company core untouched (explicitly disabled in " +
        "config/scraper.json; only turn this off once you've *verified* another scraper " +
        "actually manages this CIF's company record — an unverified guess here is exactly " +
        "what left a real company entirely missing from peviitor's company core before)"
      );
    }

    console.log("=== Step 3: Scrape jobs ===");
    const rawJobs = [];

    const careerJobs = await scrapeCareers();
    rawJobs.push(...careerJobs);

    const anofmJobs = await searchANOFM(cif);
    for (const job of anofmJobs) {
      if (!rawJobs.find(j => j.url === job.url)) {
        rawJobs.push(job);
      }
    }
    console.log(`Jobs from ANOFM: ${anofmJobs.length}`);

    console.log(`Total jobs scraped (careers site + ANOFM): ${rawJobs.length}`);

    // Canary — abort before writing anything if every source came back empty.
    assertScrapeYieldedJobs(rawJobs);

    // Drop jobs with a broken URL / empty title / bad data before publishing.
    const { kept: validJobs } = filterValidJobs(rawJobs);
    assertScrapeYieldedJobs(validJobs); // everything failed validation → also a canary

    const scrapedCount = validJobs.length;
    const jobs = validJobs.map(job => mapToJobModel(job, cif));

    const payload = {
      source: `${CAREERS_SOURCE},anofm.ro`,
      scrapedAt: new Date().toISOString(),
      company: COMPANY_NAME,
      cif: cif,
      jobs
    };

    console.log("Transforming jobs for SOLR...");
    const transformedPayload = transformJobsForSOLR(payload);
    transformedPayload.jobs = await dropDeadUrls(transformedPayload.jobs);
    const validCount = transformedPayload.jobs.filter(j => j.location).length;
    console.log(`Jobs with valid Romanian locations: ${validCount}`);

    fs.writeFileSync("scraper/jobs.json", JSON.stringify(transformedPayload, null, 2), "utf-8");
    console.log("Saved scraper/jobs.json");

    const companyData = {
      id: cif,
      company: transformedPayload.company,
      brand: companyConfig.brand || undefined,
      status: status === 'active' ? 'activ' : (status || "activ"),
      location: address ? [address] : companyConfig.location,
      website: companyConfig.website,
      career: companyConfig.career,
      lastScraped: new Date().toISOString().split('T')[0]
    };
    const markdown = generateJobsMarkdown(companyData, transformedPayload.jobs);
    fs.mkdirSync("docs", { recursive: true });
    fs.writeFileSync("docs/jobs.md", markdown, "utf-8");
    console.log("Saved docs/jobs.md");

    // docs/company.json = company identity + the URL prefix the static page uses
    // to show only jobs this scraper manages (not eJobs/BestJobs imports on the
    // same CIF).
    fs.writeFileSync(
      "docs/company.json",
      JSON.stringify({ ...companyConfig, ownJobUrlPrefix: OWN_URL_PREFIX }, null, 2),
      "utf-8"
    );
    console.log("Wrote docs/company.json (+ ownJobUrlPrefix)");

    console.log("\n=== Step 4: Upsert jobs to SOLR ===");
    if (dryRun) {
      console.log(`Dry-run — would upsert ${transformedPayload.jobs.length} jobs`);
    } else if (transformedPayload.jobs.length > 0) {
      await upsertJobs(transformedPayload.jobs);
    } else {
      console.log("No jobs scraped — skipping upsert (API rejects an empty array)");
    }

    // Step 4.5 — stale-job deletion. Disabled by default: if the CIF is shared
    // with another scraper, deleting (even scoped to our own URLs) would fight
    // that scraper on any transient fetch failure. The nightly validate-jobs.js
    // job (scoped to our URLs) handles real 404s instead.
    if (scraperConfig.staleJobDeletion) {
      const scrapedUrls = new Set(transformedPayload.jobs.map(job => job.url));
      const staleUrls = [...ownExistingUrls].filter(url => !scrapedUrls.has(url));
      if (staleUrls.length > 0 && dryRun) {
        console.log(`\n=== Step 4.5: dry-run — would delete ${staleUrls.length} stale job(s) (ours only) ===`);
      } else if (staleUrls.length > 0) {
        console.log(`\n=== Step 4.5: Delete ${staleUrls.length} stale job(s) (ours only) ===`);
        for (const url of staleUrls) {
          try {
            console.log(`  Deleting: ${url}`);
            await deleteJobByUrl(url);
          } catch (delErr) {
            console.warn(`  Failed to delete: ${url} — ${delErr.message}`);
          }
        }
      } else {
        console.log("\nNo stale jobs to delete");
      }
    } else {
      console.log(
        "\nStep 4.5 skipped — staleJobDeletion=false (deliberate: a partial scrape " +
        "failure would otherwise delete real jobs it simply failed to find this run — " +
        "use the deep-validate workflow to actually confirm and clean up dead URLs)"
      );
    }

    console.log("\n=== Step 5: Summary ===");
    await sleep(2000);
    const finalResult = await querySOLR(COMPANY_CIF);

    // Diff this run against what was in SOLR before it.
    const scrapedUrls = new Set(transformedPayload.jobs.map(job => job.url));
    const addedUrls = [...scrapedUrls].filter(url => !allExistingUrls.has(url));
    const updatedUrls = [...scrapedUrls].filter(url => allExistingUrls.has(url));
    const goneUrls = [...ownExistingUrls].filter(url => !scrapedUrls.has(url));

    const preview = (urls, n = 10) =>
      urls.slice(0, n).map(u => `    - ${u}`).join("\n") +
      (urls.length > n ? `\n    … and ${urls.length - n} more` : "");

    console.log(`\n=== SUMMARY ===`);
    console.log(`Jobs in SOLR before scrape:  ${existingCount} (${ownExistingUrls.size} ours)`);
    console.log(`Scraped this run:             ${scrapedCount} (careers site + ANOFM)`);
    console.log(`  new (not in SOLR before):  ${addedUrls.length}`);
    if (addedUrls.length) console.log(preview(addedUrls));
    console.log(`  updated (already in SOLR): ${updatedUrls.length}`);
    console.log(`  gone from site (ours):     ${goneUrls.length}${goneUrls.length && !scraperConfig.staleJobDeletion ? " — kept (staleJobDeletion=false)" : ""}`);
    if (goneUrls.length) console.log(preview(goneUrls));
    console.log(`Jobs in SOLR after scrape:    ${finalResult.numFound}`);
    console.log(`====================`);

    console.log("\n=== DONE ===");
    console.log("Scraper completed successfully!");

  } catch (err) {
    console.error("Scraper failed:", err);
    process.exit(1);
  }
}

export { parseIcimsPage, parseIcimsLocation, icimsTags, icimsSeniorityTag, icimsWorkmode, scrapeIcims, mapToJobModel, transformJobsForSOLR, scrapeCareers, fetchSitemapJobUrls, parseListing, slugify, matchSitemapUrl, matchSitemapUrlExact, parseDeadline, dropDeadUrls };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
