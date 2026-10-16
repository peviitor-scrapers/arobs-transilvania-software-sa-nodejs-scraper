import { renderHtml, BrowserUnavailable } from '../../scraper/browser.js';

// Drives a real Chromium against a data: URL (no network). Skipped when
// Playwright or its browser binaries are not installed (npx playwright install chromium).
let available = true;
try {
  const html = await renderHtml('data:text/html,' + encodeURIComponent('<p id=a></p><script>a.textContent="ok"</script>'), { timeoutMs: 15000 });
  available = html.includes('ok');
} catch (err) {
  if (!(err instanceof BrowserUnavailable)) throw err;
  available = false;
}

const itLive = available ? it : it.skip;

describe('renderHtml with a real Chromium', () => {
  itLive('sees content that only exists after JavaScript runs', async () => {
    const page = '<div id=a></div><script>document.getElementById("a").textContent="rendered-by-js"</script>';
    const html = await renderHtml('data:text/html,' + encodeURIComponent(page), { waitSelector: '#a', timeoutMs: 15000 });
    expect(html).toContain('rendered-by-js');
  });
});