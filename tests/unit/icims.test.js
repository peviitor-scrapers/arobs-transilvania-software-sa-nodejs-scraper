import { jest } from '@jest/globals';

describe('iCIMS source', () => {
  let index;

  beforeAll(async () => {
    index = await import('../../scraper/index.js');
  });

  const card = (title, href, loc, category, seniority, desc = '') => `
    <li class="iCIMS_JobCardItem">
      <div class="title"><a class="iCIMS_Anchor" href="${href}"><h3>${title}</h3></a></div>
      <div class="header left"><span>Location</span><span>${loc}</span></div>
      <div class="iCIMS_JobHeaderTag"><dl><dt class="iCIMS_JobHeaderField">Category</dt><dd><span>${category}</span></dd></dl></div>
      <div class="iCIMS_JobHeaderTag"><dl><dt class="iCIMS_JobHeaderField">Seniority</dt><dd><span>${seniority}</span></dd></dl></div>
      <div class="description">${desc}</div>
    </li>`;

  const page = `
    <h2 class="iCIMS_SubHeader_Jobs">Search Results Page 1 of 3</h2>
    <ul>
      ${card('Senior Java Developer', '/jobs/1234/senior-java-developer/job?in_iframe=1', 'RO-Cluj Napoca | RO-Bucharest', 'Development', 'Senior')}
      ${card('QA Engineer &amp; Tester', '/jobs/1235/qa-engineer/job?in_iframe=1', 'RO', 'Testing', 'Junior', 'Fully remote position')}
      <li class="iCIMS_JobCardItem"><div class="title"></div></li>
    </ul>`;

  it('parses cards, resolves relative URLs and strips in_iframe', () => {
    const { jobs, currentPage, totalPages } = index.parseIcimsPage(page, 'https://careers-arobs.icims.com/jobs/search?ss=1');
    expect(jobs).toHaveLength(2);
    expect(jobs[0].url).toBe('https://careers-arobs.icims.com/jobs/1234/senior-java-developer/job');
    expect(jobs[0].title).toBe('Senior Java Developer');
    expect(currentPage).toBe(1);
    expect(totalPages).toBe(3);
  });

  it('maps locations, dropping the RO- prefix and normalising city names', () => {
    const { jobs } = index.parseIcimsPage(page, 'https://careers-arobs.icims.com/');
    expect(jobs[0].location).toEqual(['Cluj-Napoca', 'București']);
    expect(jobs[1].location).toEqual(['România']);
  });

  it('decodes entities in titles and detects remote work from the description', () => {
    const { jobs } = index.parseIcimsPage(page, 'https://careers-arobs.icims.com/');
    expect(jobs[1].title).toBe('QA Engineer & Tester');
    expect(jobs[1].workmode).toBe('remote');
    expect(jobs[0].workmode).toBe('on-site');
  });

  it('builds tags from seniority, category and the title only', () => {
    expect(index.icimsTags({ title: 'Senior Java Developer', category: 'Development', seniority: 'Senior' }))
      .toEqual(expect.arrayContaining(['senior', 'it']));
    expect(index.icimsTags({ title: 'Office Assistant', category: '', seniority: '' })).toEqual([]);
  });

  it('does not invent a seniority tag when the portal gives none', () => {
    expect(index.icimsSeniorityTag('')).toBeNull();
    expect(index.icimsSeniorityTag('Junior')).toBe('junior');
  });
});
