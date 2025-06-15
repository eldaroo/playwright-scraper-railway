  for (const catUrl of allCategories) {
    let nextPageUrl = catUrl;
    let visited = new Set();
    let pageCount = 1;
    while (nextPageUrl && !visited.has(nextPageUrl)) {
      visited.add(nextPageUrl);
      allPages.push(nextPageUrl);
      try {
        await page.goto(nextPageUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1000);
        console.log(`[DISCOVERY][${catUrl}] Página ${pageCount}: ${nextPageUrl}`);
        const nextHref = await page.$eval(
          'a.next.page-number[aria-label="Next"]',
          el => el.getAttribute('href'),
        ).catch(() => null);
        if (nextHref) {
          const resolved = nextHref.startsWith('http') ? nextHref : new URL(nextHref, siteConfig.base_url).href;
          console.log(`[DISCOVERY][${catUrl}] Next encontrado: ${resolved}`);
          nextPageUrl = resolved;
        } else {
          console.log(`[DISCOVERY][${catUrl}] No se encontró botón Next en ${nextPageUrl}`);
          nextPageUrl = null;
        }
        pageCount++;
      } catch (e) {
        console.log(`[DISCOVERY][${catUrl}] Error navegando a ${nextPageUrl} para paginación dinámica:`, e.message);
        nextPageUrl = null;
      }
    }
  } 

  await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const baseSel = siteConfig.extraction_config.params.schema.baseSelector;
  await page.waitForSelector(baseSel, { timeout: 20000 });
  
  // Esperar a que las imágenes se carguen
  await page.waitForFunction(() => {
    const imgs = Array.from(document.querySelectorAll('div.box-image img'));
    return imgs.length > 0 && imgs.every(img => 
      img.complete && 
      img.naturalHeight !== 0 && 
      !img.src.startsWith('data:image/svg+xml')
    );
  }, { timeout: 15000 }).catch(() => {
    console.log('[SCRAPER] Timeout esperando imágenes, continuando...');
  });
  
  const products = await page.$$eval(
  // ... existing code ...
  ); 