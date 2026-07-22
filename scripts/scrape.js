const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const https = require('https');
const http = require('http');

const startUrl = process.env.TARGET_URL || 'https://example.com';
const outputDir = path.resolve('./scraped-site');
const assetsDir = path.join(outputDir, 'assets');
const manifest = {}; // localPath -> originalUrl

function hashName(resourceUrl) {
  try {
    const u = new URL(resourceUrl);
    let ext = path.extname(u.pathname);
    if (!ext || ext.length > 8) ext = '';
    const hash = crypto.createHash('md5').update(resourceUrl).digest('hex').slice(0, 16);
    return `${hash}${ext}`;
  } catch (e) {
    const hash = crypto.createHash('md5').update(resourceUrl).digest('hex').slice(0, 16);
    return `${hash}.bin`;
  }
}

function ensureDirSync(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = ''; // Strip fragment
    return u.toString();
  } catch (e) {
    return null;
  }
}

function getBaseHost(urlStr) {
  try {
    return new URL(urlStr).hostname;
  } catch (e) {
    return '';
  }
}

function isSameDomain(urlStr, targetStartUrl) {
  const host1 = getBaseHost(urlStr);
  const host2 = getBaseHost(targetStartUrl);
  return host1 && host2 && host1 === host2;
}

function urlToHtmlFilename(urlStr, startUrlStr) {
  const norm = normalizeUrl(urlStr);
  const normStart = normalizeUrl(startUrlStr);
  if (norm === normStart || norm === normStart + '/') return 'index.html';

  let clean = norm.replace(normStart, '').replace(/^[\/]+/, '');
  clean = clean.replace(/[\/\?&%#:]/g, '_');
  if (!clean) clean = 'index';
  if (!clean.endsWith('.html')) clean += '.html';
  return clean;
}

// Download remote asset directly via http/https (for CSS sub-resources)
function downloadDirect(urlStr) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const client = u.protocol === 'https:' ? https : http;
      client.get(urlStr, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, urlStr).toString();
          return downloadDirect(redirectUrl).then(resolve);
        }
        if (res.statusCode !== 200) return resolve(null);
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => resolve(null));
      }).on('error', () => resolve(null));
    } catch (e) {
      resolve(null);
    }
  });
}

(async () => {
  const initialUrl = normalizeUrl(startUrl);
  if (!initialUrl) {
    console.error('Invalid TARGET_URL:', startUrl);
    process.exit(1);
  }

  const visited = new Set();
  const toVisit = [initialUrl];
  const downloaded = new Map(); // originalUrl -> localRelativePath ('assets/xxx.ext')
  const pageToFilename = new Map(); // pageUrl -> htmlFilename ('index.html', 'about.html')
  const savedPages = []; // [{ pageUrl, fileName, rawHtmlPath }]

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  page.on('response', async (response) => {
    try {
      const respUrl = response.url();
      const normRespUrl = normalizeUrl(respUrl) || respUrl;
      if (downloaded.has(normRespUrl)) return;

      const req = response.request();
      const resourceType = req.resourceType();
      if (!['stylesheet', 'script', 'image', 'font', 'media'].includes(resourceType)) return;

      const status = response.status();
      if (status >= 300 && status < 400) return;

      const buffer = await response.buffer();
      const localName = hashName(normRespUrl);
      const localPath = path.join(assetsDir, localName);
      ensureDirSync(localPath);
      fs.writeFileSync(localPath, buffer);

      const localRelative = `assets/${localName}`;
      downloaded.set(normRespUrl, localRelative);
      downloaded.set(respUrl, localRelative);
      manifest[localRelative] = normRespUrl;
    } catch (err) {
      // Handle opaque or destroyed response buffers gracefully
    }
  });

  console.log(`Starting crawl at: ${initialUrl}`);

  while (toVisit.length > 0) {
    const currentUrl = toVisit.shift();
    const normCurrentUrl = normalizeUrl(currentUrl);
    if (!normCurrentUrl || visited.has(normCurrentUrl)) continue;

    visited.add(normCurrentUrl);
    const fileName = urlToHtmlFilename(normCurrentUrl, initialUrl);
    pageToFilename.set(normCurrentUrl, fileName);

    console.log(`\n[${visited.size}] Scraping: ${normCurrentUrl} -> ${fileName}`);

    try {
      await page.goto(normCurrentUrl, { waitUntil: 'networkidle0', timeout: 35000 });

      // Trigger accordions and collapsible sections safely
      await page.evaluate(() => {
        document.querySelectorAll('[aria-expanded="false"], .accordion-header, details:not([open]) summary').forEach(el => {
          try { el.click(); } catch(e) {}
        });
      });
      await new Promise(r => setTimeout(r, 600));

      // Scroll to trigger lazy-loaded assets and dynamic content
      await page.evaluate(async () => {
        await new Promise((resolve) => {
          let total = 0;
          const distance = 400;
          const timer = setInterval(() => {
            window.scrollBy(0, distance);
            total += distance;
            if (total >= document.body.scrollHeight || total >= 15000) {
              clearInterval(timer);
              resolve();
            }
          }, 100);
        });
      });
      await new Promise(r => setTimeout(r, 600));

      const rawHtml = await page.content();
      const tempHtmlPath = path.join(outputDir, fileName);
      fs.writeFileSync(tempHtmlPath, rawHtml);

      savedPages.push({ pageUrl: normCurrentUrl, fileName, rawHtmlPath: tempHtmlPath });

      // Discover internal same-domain links
      const links = await page.$$eval('a[href]', anchors => anchors.map(a => a.href));
      for (const link of links) {
        const normLink = normalizeUrl(link);
        if (normLink && isSameDomain(normLink, initialUrl) && !visited.has(normLink) && !toVisit.includes(normLink)) {
          toVisit.push(normLink);
          if (!pageToFilename.has(normLink)) {
            pageToFilename.set(normLink, urlToHtmlFilename(normLink, initialUrl));
          }
        }
      }
    } catch (err) {
      console.error(`Failed to scrape ${normCurrentUrl}: ${err.message}`);
    }
  }

  await browser.close();

  // ---- POST-PROCESSING STEP 1: CSS Internal Resource Extraction ----
  console.log('\nProcessing CSS sub-resources (fonts, images inside CSS)...');
  const cssFiles = fs.readdirSync(assetsDir).filter(f => f.endsWith('.css'));
  for (const cssFile of cssFiles) {
    const cssPath = path.join(assetsDir, cssFile);
    let cssText = fs.readFileSync(cssPath, 'utf8');
    const originalCssUrl = manifest[`assets/${cssFile}`];

    if (originalCssUrl) {
      const urlRegex = /url\(\s*['"]?([^'")]ConfigFile|\S+?)['"]?\s*\)/gi;
      let match;
      const subResourcesToFetch = [];

      while ((match = urlRegex.exec(cssText)) !== null) {
        const subUrlRaw = match[1];
        if (subUrlRaw.startsWith('data:') || subUrlRaw.startsWith('#')) continue;
        try {
          const resolvedUrl = new URL(subUrlRaw, originalCssUrl).toString();
          subResourcesToFetch.push({ raw: subUrlRaw, resolved: resolvedUrl });
        } catch (e) {}
      }

      for (const item of subResourcesToFetch) {
        if (!downloaded.has(item.resolved)) {
          const subBuffer = await downloadDirect(item.resolved);
          if (subBuffer) {
            const subLocalName = hashName(item.resolved);
            const subLocalPath = path.join(assetsDir, subLocalName);
            fs.writeFileSync(subLocalPath, subBuffer);
            const subLocalRelative = `assets/${subLocalName}`;
            downloaded.set(item.resolved, subLocalRelative);
            manifest[subLocalRelative] = item.resolved;
          }
        }

        const localRelPath = downloaded.get(item.resolved);
        if (localRelPath) {
          const assetOnlyFilename = path.basename(localRelPath);
          cssText = cssText.split(item.raw).join(assetOnlyFilename);
        }
      }
      fs.writeFileSync(cssPath, cssText);
    }
  }

  // ---- POST-PROCESSING STEP 2: Full HTML Link & Asset Rewriting ----
  console.log('\nPost-processing HTML files for 100% offline navigation and local assets...');
  const baseHost = getBaseHost(initialUrl);

  for (const pageInfo of savedPages) {
    let html = fs.readFileSync(pageInfo.rawHtmlPath, 'utf8');

    // 1. Rewrite Page-to-Page Internal Links (<a href="...">)
    for (const [pageUrl, targetHtmlFile] of pageToFilename.entries()) {
      html = html.split(`href="${pageUrl}"`).join(`href="${targetHtmlFile}"`);
      html = html.split(`href='${pageUrl}'`).join(`href='${targetHtmlFile}'`);

      try {
        const u = new URL(pageUrl);
        if (u.hostname === baseHost) {
          const rootRel = u.pathname + u.search;
          if (rootRel && rootRel !== '/') {
            html = html.split(`href="${rootRel}"`).join(`href="${targetHtmlFile}"`);
            html = html.split(`href='${rootRel}'`).join(`href='${targetHtmlFile}'`);
          }
        }
      } catch (e) {}
    }

    // 2. Rewrite Asset URLs (CSS, JS, Images, Media)
    for (const [originalAssetUrl, localAssetPath] of downloaded.entries()) {
      html = html.split(originalAssetUrl).join(localAssetPath);

      try {
        const u = new URL(originalAssetUrl);
        if (u.hostname === baseHost) {
          const rootRel = u.pathname + u.search;
          if (rootRel && rootRel !== '/') {
            html = html.split(`"${rootRel}"`).join(`"${localAssetPath}"`);
            html = html.split(`'${rootRel}'`).join(`'${localAssetPath}'`);
          }
        }
      } catch (e) {}
    }

    fs.writeFileSync(pageInfo.rawHtmlPath, html);
    console.log(`Rewritten offline links for: ${pageInfo.fileName}`);
  }

  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n✅ Clone Complete! Total Pages: ${visited.size}, Total Assets: ${downloaded.size}`);
})();