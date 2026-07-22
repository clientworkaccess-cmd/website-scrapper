const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const startUrl = process.env.TARGET_URL || 'https://example.com';
const outputDir = './scraped-site';
const assetsDir = path.join(outputDir, 'assets');
const manifest = {}; // localPath -> originalUrl (exact, unmodified)

function hashName(resourceUrl) {
  const u = new URL(resourceUrl);
  let ext = path.extname(u.pathname);
  if (!ext || ext.length > 6) ext = ''; // ajeeb/long "extensions" (query wale) ignore
  const hash = crypto.createHash('md5').update(resourceUrl).digest('hex').slice(0, 16);
  return `${hash}${ext}`;
}

function ensureDirSync(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

(async () => {
  const visited = new Set();
  const toVisit = [startUrl];
  const downloaded = new Map(); // originalUrl -> localRelativePath

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  fs.mkdirSync(outputDir, { recursive: true });

  while (toVisit.length > 0) {
    const url = toVisit.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    const page = await browser.newPage();

    page.on('response', async (response) => {
      try {
        const respUrl = response.url();
        if (downloaded.has(respUrl)) return;

        const resourceType = response.request().resourceType();
        if (!['stylesheet', 'script', 'image', 'font', 'media'].includes(resourceType)) return;

        const status = response.status();
        if (status >= 300 && status < 400) return;

        const buffer = await response.buffer();
        const localName = hashName(respUrl);
        const localPath = path.join(assetsDir, localName);
        ensureDirSync(localPath);
        fs.writeFileSync(localPath, buffer);

        const localRelative = `assets/${localName}`;
        downloaded.set(respUrl, localRelative);
        manifest[localRelative] = respUrl; // exact original URL, kabhi tamper nahi hui
      } catch (err) {
        // opaque/cached responses skip
      }
    });

    try {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

      // Accordion/collapsible content force-open (FAQ jaisa hidden content bhi aa jaye)
      await page.evaluate(() => {
        document.querySelectorAll('button').forEach(btn => {
          if (btn.querySelector('svg')) btn.click();
        });
      });
      await new Promise(r => setTimeout(r, 800));

      // Lazy-loaded content trigger karne k liye scroll
      await page.evaluate(async () => {
        await new Promise((resolve) => {
          let total = 0;
          const timer = setInterval(() => {
            window.scrollBy(0, 400);
            total += 400;
            if (total >= document.body.scrollHeight) {
              clearInterval(timer);
              resolve();
            }
          }, 100);
        });
      });
      await new Promise(r => setTimeout(r, 800));

      let html = await page.content();

      // Same-page naye links dhoondo (crawl continue karne k liye)
      const baseHost = new URL(startUrl).hostname;
      const links = await page.$$eval('a', as => as.map(a => a.href));
      for (const link of links) {
        try {
          if (new URL(link).hostname === baseHost && !visited.has(link)) {
            toVisit.push(link);
          }
        } catch (e) {}
      }

      // ---- LINK REWRITING: har asset URL ko local relative path se replace karo ----
      for (const [originalUrl, localRelative] of downloaded.entries()) {
        // Full absolute URL replace karo
        html = html.split(originalUrl).join(localRelative);

        // Root-relative form bhi replace karo (e.g. "/assets/index-XXX.js")
        try {
          const u = new URL(originalUrl);
          if (u.hostname === baseHost) {
            const rootRelative = u.pathname + u.search;
            html = html.split(`"${rootRelative}"`).join(`"${localRelative}"`);
          }
        } catch (e) {}
      }

      const fileName = url.replace(startUrl, '').replace(/\//g, '_') || 'index';
      fs.writeFileSync(path.join(outputDir, `${fileName}.html`), html);
      console.log('Saved:', url);
    } catch (err) {
      console.error('Failed:', url, err.message);
    }

    await page.close();
  }

  await browser.close();

  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Done. Pages: ${visited.size}, Assets: ${downloaded.size}`);
})();