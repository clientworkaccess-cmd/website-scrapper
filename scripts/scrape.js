const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const https = require('https');
const http = require('http');
const archiver = require('archiver');

const startUrl = process.env.TARGET_URL || 'https://example.com';
const outputDir = path.resolve('./scraped-site');
const assetsDir = path.join(outputDir, 'assets');
const manifest = {}; // localPath -> originalUrl

function hashName(resourceUrl, contentType = '') {
  try {
    const u = new URL(resourceUrl);
    let ext = path.extname(u.pathname);

    // Check inner query param for Next.js image URLs (/_next/image?url=...)
    if ((!ext || ext.length > 8) && u.searchParams.has('url')) {
      const innerUrl = u.searchParams.get('url');
      try {
        ext = path.extname(new URL(innerUrl, resourceUrl).pathname);
      } catch (e) {}
    }

    // Infer extension from Content-Type if ext is still missing
    if (!ext || ext.length > 8) {
      const ct = (contentType || '').toLowerCase();
      if (ct.includes('image/png')) ext = '.png';
      else if (ct.includes('image/webp')) ext = '.webp';
      else if (ct.includes('image/jpeg') || ct.includes('image/jpg')) ext = '.jpg';
      else if (ct.includes('image/svg')) ext = '.svg';
      else if (ct.includes('image/gif')) ext = '.gif';
      else if (ct.includes('text/css')) ext = '.css';
      else if (ct.includes('javascript')) ext = '.js';
      else if (ct.includes('font/woff2')) ext = '.woff2';
      else if (ct.includes('font/woff')) ext = '.woff';
      else ext = '';
    }

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

function createZipArchive(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      console.log(`ZIP created: ${outPath} (${archive.pointer()} total bytes)`);
      resolve();
    });

    archive.on('error', (err) => reject(err));
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
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
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

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
      const contentType = response.headers()['content-type'] || '';
      const localName = hashName(normRespUrl, contentType);
      const localPath = path.join(assetsDir, localName);
      ensureDirSync(localPath);
      fs.writeFileSync(localPath, buffer);

      const localRelative = `assets/${localName}`;
      downloaded.set(normRespUrl, localRelative);
      downloaded.set(respUrl, localRelative);
      manifest[localRelative] = normRespUrl;
    } catch (err) {
      // Ignore destroyed response errors
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

      // Trigger ONLY FAQ / content accordions (EXCLUDING mobile menu toggles and hamburger buttons)
      await page.evaluate(() => {
        document.querySelectorAll('.faq-item summary, .elementor-accordion-title, details:not([open]) summary, .accordion-button.collapsed').forEach(el => {
          if (el.closest('nav') || el.closest('.mobile-menu') || el.closest('.navbar') || el.closest('header')) return;
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

      // Force lazy-loaded images to populate real src & srcset attributes
      await page.evaluate(() => {
        document.querySelectorAll('img, source').forEach(img => {
          const dSrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
          const dSrcSet = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
          if (dSrc) img.setAttribute('src', dSrc);
          if (dSrcSet) img.setAttribute('srcset', dSrcSet);
        });
      });

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

  // ---- POST-PROCESSING STEP 1: CSS Sub-Resources ----
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
        if (subUrlRaw.startsWith('data:') || subUrlRaw.startsWith('#') || subUrlRaw.startsWith('%23')) continue;
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
          cssText = cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, innerUrl) => {
            if (innerUrl.trim() === item.raw.trim()) {
              return `url("${assetOnlyFilename}")`;
            }
            return m;
          });
        }
      }

      // Update relative asset paths in CSS file to point to assets/
      cssText = cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, urlStr) => {
        const u = urlStr.trim();
        if (
          u.startsWith('/') ||
          u.startsWith('data:') ||
          u.startsWith('http:') ||
          u.startsWith('https:') ||
          u.startsWith('#') ||
          u.startsWith('%23') ||
          u.startsWith('blob:') ||
          u.startsWith('assets/')
        ) {
          return match;
        }
        const cleanFile = u.replace(/^\.\//, '');
        return `url("${cleanFile}")`;
      });

      fs.writeFileSync(cssPath, cssText);
    }
  }

  // ---- POST-PROCESSING STEP 2: HTML Link & Asset Rewriting ----
  console.log('\nPost-processing HTML files for 100% offline navigation and local assets...');
  const baseHost = getBaseHost(initialUrl);

  for (const pageInfo of savedPages) {
    let html = fs.readFileSync(pageInfo.rawHtmlPath, 'utf8');

    // 1. Rewrite Page-to-Page Internal Links (<a href="...">) to local .html files
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
          const pathOnly = u.pathname;
          if (pathOnly && pathOnly !== '/') {
            html = html.split(`href="${pathOnly}"`).join(`href="${targetHtmlFile}"`);
            html = html.split(`href='${pathOnly}'`).join(`href='${targetHtmlFile}'`);
            if (pathOnly.endsWith('/')) {
              const noSlash = pathOnly.slice(0, -1);
              html = html.split(`href="${noSlash}"`).join(`href="${targetHtmlFile}"`);
              html = html.split(`href='${noSlash}'`).join(`href='${targetHtmlFile}'`);
            }
          }
        }
      } catch (e) {}
    }

    // 2. Rewrite Asset URLs (CSS, JS, Images, Fonts, Media)
    for (const [originalAssetUrl, localAssetPath] of downloaded.entries()) {
      html = html.split(originalAssetUrl).join(localAssetPath);
      try {
        const u = new URL(originalAssetUrl);
        const rootRel = u.pathname + u.search;
        if (rootRel && rootRel !== '/') {
          html = html.split(`"${rootRel}"`).join(`"${localAssetPath}"`);
          html = html.split(`'${rootRel}'`).join(`'${localAssetPath}'`);
        }
        const relNoSlash = u.pathname.replace(/^\//, '');
        if (relNoSlash) {
          html = html.split(`"${relNoSlash}"`).join(`"${localAssetPath}"`);
          html = html.split(`'${relNoSlash}'`).join(`'${localAssetPath}'`);
        }
      } catch (e) {}
    }

    // Strip target site's old Next.js framework chunk scripts & __NEXT_DATA__ if scraping a Next.js site
    html = html.replace(/<script\b[^>]*id="__NEXT_DATA__"[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<script\b[^>]*src="[^"]*\/_next\/static\/chunks\/[^"]*"[^>]*><\/script>/gi, '');
    html = html.replace(/<script\b[^>]*src='[^']*\/_next\/static\/chunks\/[^']*'[^>]*><\/script>/gi, '');

    // Rewrite srcset responsive image URLs
    html = html.replace(/\bsrcset=(["'])([\s\S]*?)\1/gi, (match, quote, srcsetContent) => {
      const parts = srcsetContent.split(',');
      const newParts = parts.map(part => {
        const trimmed = part.trim();
        if (!trimmed) return part;
        const spaceIdx = trimmed.search(/\s/);
        const urlPart = spaceIdx !== -1 ? trimmed.slice(0, spaceIdx) : trimmed;
        const descriptor = spaceIdx !== -1 ? trimmed.slice(spaceIdx) : '';

        for (const [origUrl, localRel] of downloaded.entries()) {
          if (urlPart === origUrl) return `${localRel}${descriptor}`;
          try {
            const u = new URL(origUrl);
            if (urlPart === u.pathname + u.search || urlPart === u.pathname) return `${localRel}${descriptor}`;
          } catch (e) {}
        }
        return part;
      });
      return `srcset=${quote}${newParts.join(', ')}${quote}`;
    });

    fs.writeFileSync(pageInfo.rawHtmlPath, html);
  }

  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // ---- STEP 3: COMPRESS PURE HTML/CSS/JS SITE TO ZIP ----
  console.log('\nCompressing Pure HTML, CSS & JS website into ZIP archive...');
  const zipOutputPath = path.resolve('./scraped-site.zip');
  await createZipArchive(outputDir, zipOutputPath);

  console.log(`\n🎉 SUCCESS! Complete Website Scraped as Pure HTML, CSS & JS!`);
  console.log(`- Scraped Directory: ${outputDir}`);
  console.log(`- Downloadable ZIP: ${zipOutputPath}`);
  console.log(`Total Pages: ${visited.size}, Total Assets: ${downloaded.size}`);
  process.exit(0);
})();
