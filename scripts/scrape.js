const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const startUrl = process.env.TARGET_URL || 'https://example.com';
const outputDir = './scraped-site';
const assetsDir = path.join(outputDir, 'assets');

function urlToLocalPath(resourceUrl) {
  const u = new URL(resourceUrl);
  let pathname = u.pathname;
  if (pathname === '' || pathname === '/') pathname = '/index';

  // Host ko bhi path mein shamil karo taake alag domains clash na karein
  const safeName = (u.hostname + pathname + (u.search || ''))
    .replace(/^\//, '')
    .replace(/[?&=]/g, '_');
  return safeName || 'file';
}

function ensureDirSync(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

(async () => {
  const visited = new Set();
  const toVisit = [startUrl];
  const downloadedAssets = new Set();

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  fs.mkdirSync(outputDir, { recursive: true });

  while (toVisit.length > 0) {
    const url = toVisit.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    const page = await browser.newPage();

    // Har response (kisi bhi domain se) intercept kar k save karo
    page.on('response', async (response) => {
      try {
        const respUrl = response.url();
        if (downloadedAssets.has(respUrl)) return;

        const resourceType = response.request().resourceType();
        if (!['stylesheet', 'script', 'image', 'font', 'media', 'document'].includes(resourceType)) return;

        const status = response.status();
        if (status >= 300 && status < 400) return; // redirects skip

        const buffer = await response.buffer();
        const localPath = path.join(assetsDir, urlToLocalPath(respUrl));
        ensureDirSync(localPath);
        fs.writeFileSync(localPath, buffer);
        downloadedAssets.add(respUrl);
      } catch (err) {
        // kuch responses buffer nahi dete (cached/opaque), unhe skip karo
      }
    });

    try {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      const html = await page.content();

      const fileName = url.replace(startUrl, '').replace(/\//g, '_') || 'index';
      fs.writeFileSync(path.join(outputDir, `${fileName}.html`), html);
      console.log('Saved page:', url);

      // Sirf same-domain pages hi crawl karo (assets alag baat hai, wo download ho hi rahe hain upar)
      const baseHost = new URL(startUrl).hostname;
      const links = await page.$$eval('a', as => as.map(a => a.href));
      for (const link of links) {
        try {
          const linkHost = new URL(link).hostname;
          if (linkHost === baseHost && !visited.has(link)) {
            toVisit.push(link);
          }
        } catch (e) {}
      }
    } catch (err) {
      console.error('Failed:', url, err.message);
    }

    await page.close();
  }

  await browser.close();
  console.log('Total pages:', visited.size);
  console.log('Total assets:', downloadedAssets.size);
})();