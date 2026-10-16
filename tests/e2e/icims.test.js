import scraperConfig from '../../scraper/config/scraper.js';

describe('E2E: live iCIMS portal', () => {
  it('returns at least one well-formed job from the first page', async () => {
    const { parseIcimsPage } = await import('../../scraper/index.js');
    const res = await fetch(scraperConfig.sources.icims, { headers: { 'User-Agent': scraperConfig.userAgent } });
    expect(res.ok).toBe(true);
    const { jobs } = parseIcimsPage(await res.text());
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(j.url.startsWith(scraperConfig.ownJobUrlPrefix)).toBe(true);
      expect(j.title).toBeTruthy();
      expect(j.location.length).toBeGreaterThan(0);
    }
  }, 30000);
});
