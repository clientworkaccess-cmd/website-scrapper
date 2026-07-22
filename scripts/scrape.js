const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const startUrl = process.env.TARGET_URL || 'https://example.com';
const outputDir = './scraped-site';

(async () => {
  const visited = new Set();
  const toVisit = [startUrl];
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

  while (toVisit.length > 0) {
    const url = toVisit.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      const html = await page.content();

      const fileName = url.replace(startUrl, '').replace(/\//g, '_') || 'index';
      fs.writeFileSync(path.join(outputDir, `${fileName}.html`), html);
      console.log('Saved:', url);

      // Same-domain links dhoondo
      const links = await page.$$eval('a', as => as.map(a => a.href));
      for (const link of links) {
        if (link.startsWith(startUrl) && !visited.has(link)) {
          toVisit.push(link);
        }
      }
    } catch (err) {
      console.error('Failed:', url, err.message);
    }
  }

  await browser.close();
})();