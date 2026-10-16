// Page fetching with optional headless-browser rendering (Playwright).
//
// Most career sites are server-rendered and a plain fetch is enough (the
// default, rendering.mode = "static"). Sites that build their job list in
// JavaScript (React / Algolia / SuccessFactors search, ...) return an empty
// shell to node-fetch; for those set in scraper/config/scraper.json:
//
//   "rendering": { "mode": "browser", "waitSelector": ".job-card", "timeoutMs": 30000 }
//
// "auto" fetches statically first and only renders in a browser when the
// caller's parseOk() says the static HTML held no jobs, so a site that starts
// client-rendering later keeps working instead of silently returning 0 jobs.
//
// Playwright is imported lazily: a scraper that stays in "static" mode does not
// need browser binaries (`npx playwright install chromium`).

import fetch from "node-fetch";
import scraperConfig, { userAgent } from "./config/scraper.js";

const R = scraperConfig.rendering || {};
export const MODE = R.mode || "static";
const WAIT_SELECTOR = R.waitSelector || null;
const TIMEOUT_MS = Number(R.timeoutMs || 30000);
const REQUEST_TIMEOUT = scraperConfig.requestTimeoutMs;
export const VALID_MODES = ["static", "browser", "auto"];

export class BrowserUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "BrowserUnavailable";
  }
}

/**
 * Return the DOM of `url` after JavaScript has run.
 * `loadPlaywright` is injectable for tests; production leaves the default.
 */
export async function renderHtml(
  url,
  { waitSelector = WAIT_SELECTOR, timeoutMs = TIMEOUT_MS, loadPlaywright = () => import("playwright") } = {}
) {
  let chromium;
  try {
    ({ chromium } = await loadPlaywright());
  } catch (err) {
    throw new BrowserUnavailable(`playwright is not installed (npm i playwright): ${err.message}`);
  }

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    if (/Executable doesn't exist|playwright install/i.test(err.message)) {
      throw new BrowserUnavailable("chromium is not installed (npx playwright install chromium)");
    }
    throw err;
  }

  try {
    const page = await (await browser.newContext({ userAgent })).newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
    if (waitSelector) await page.waitForSelector(waitSelector, { timeout: timeoutMs });
    return await page.content();
  } finally {
    await browser.close();
  }
}

async function staticFetch(url) {
  const res = await fetch(url, { timeout: REQUEST_TIMEOUT, headers: { "User-Agent": userAgent } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

/**
 * Fetch `url` according to the configured rendering mode.
 * parseOk(html) tells "auto" mode whether the static HTML already holds what
 * the caller needs; if it is falsy the page is rendered in a browser.
 */
export async function getHtml(
  url,
  { mode = MODE, parseOk, render = renderHtml, fetchHtml = staticFetch, log = console.log } = {}
) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`rendering.mode must be one of ${VALID_MODES.join(", ")}, got "${mode}"`);
  }
  if (mode === "browser") return render(url);

  const html = await fetchHtml(url);
  if (mode === "auto" && parseOk && !parseOk(html)) {
    log("  static HTML had no jobs, rendering in a browser");
    try {
      return await render(url);
    } catch (err) {
      if (!(err instanceof BrowserUnavailable)) throw err;
      log(`  ${err.message} -- keeping the static HTML`);
    }
  }
  return html;
}