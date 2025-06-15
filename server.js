import express from 'express';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());

if (!fs.existsSync('./screenshots')) {
  fs.mkdirSync('./screenshots');
}

function loadSiteConfigs() {
  const configs = {};
  const configFiles = fs.readdirSync('./configs');
  for (const file of configFiles) {
    if (file.endsWith('.json')) {
      const siteName = path.basename(file, '.json');
      const config = JSON.parse(fs.readFileSync(`./configs/${file}`, 'utf8'));
      configs[siteName] = config;
    }
  }
  return configs;
}

async function performLogin(page, authConfig) {
  console.log('[AUTH] Iniciando proceso de login...');
  try {
    await page.goto(authConfig.login_url);
    await page.click(authConfig.login_button_selector);
    console.log('[AUTH] Modal de login abierto');
    await page.waitForSelector(authConfig.form_selectors.username);
    await page.waitForSelector(authConfig.form_selectors.password);
    await page.fill(authConfig.form_selectors.username, authConfig.credentials.username);
    await page.fill(authConfig.form_selectors.password, authConfig.credentials.password);
    console.log('[AUTH] Credenciales ingresadas');
    await page.click(authConfig.submit_button);
    await page.waitForSelector(authConfig.success_check.selector, { timeout: authConfig.success_check.timeout });
    console.log('[AUTH] Login exitoso');
    return true;
  } catch (error) {
    console.error('[AUTH] Error en el proceso de login:', error);
    throw new Error(`Fallo en el proceso de login: ${error.message}`);
  }
}

async function discoverCategories(browser, siteConfig) {
  console.log(`[DISCOVERY] Finding categories for ${siteConfig.site_name}`);
  const page = await browser.newPage();
  if (siteConfig.auth_config) {
    await performLogin(page, siteConfig.auth_config);
  }
  try {
    // Si hay categories_config, usar lógica dinámica
    if (siteConfig.categories_config) {
      await page.goto(siteConfig.base_url, { waitUntil: 'networkidle' });
      const sel = siteConfig.categories_config.selector;
      const attr = siteConfig.categories_config.attribute;
      let allCategories = await page.$$eval(
        sel,
        (els, mapAttr) => els.map(e => e.getAttribute(mapAttr)),
        attr
      );
      // Filtrar fuera lo que no queremos
      allCategories = allCategories
        .filter(href => href && (href.startsWith('http') || href.startsWith('/')))
        .filter(href =>
          !siteConfig.categories_config.exclude_patterns?.some(p => href.includes(p))
        );
      allCategories = Array.from(new Set(allCategories));
      // Normalizar URLs
      allCategories = allCategories.map(href => {
        try {
          return new URL(href).toString();
        } catch {
          return new URL(href, siteConfig.base_url).toString();
        }
      });
      allCategories = Array.from(new Set(allCategories));
      // PAGINACIÓN DINÁMICA: para cada categoría, seguir el botón Next hasta que no exista más
      let allPages = [];
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
            const screenshotPath = `screenshots/pagination_${encodeURIComponent(nextPageUrl)}.png`;
            await page.screenshot({ path: screenshotPath });
            console.log(`[DISCOVERY][${catUrl}] Página ${pageCount}: ${nextPageUrl} (screenshot: ${screenshotPath})`);
            // Buscar el botón Next
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
      allPages = [...new Set(allPages)];
      console.log(`[DISCOVERY] Found ${allPages.length} total paginated URLs (dinámica)`);
      await page.close();
      return allPages;
    } else {
      // Si no hay categories_config, retornar vacío (o lanzar error si es obligatorio)
      await page.close();
      return [];
    }
  } catch (error) {
    console.error(`[DISCOVERY ERROR] Could not discover categories:`, error);
    await page.close();
    throw error;
  }
}

async function scrapeUrl(browser, url, siteConfig, context) {
  console.log(`[SCRAPER] Starting scrape on: ${url}`);
  let page = null;
  try {
    page = await context.newPage();
    await page.setViewportSize(siteConfig.crawler_params.defaultViewport);
    let nextUrl = url;
    let pageNum = 1;
    const results = [];
    while (nextUrl) {
      console.log(`[SCRAPER] Page ${pageNum} → ${nextUrl}`);
      await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const baseSel = siteConfig.extraction_config.params.schema.baseSelector;
      await page.waitForSelector(baseSel, { timeout: 20000 });
      
      // Forzar carga de imágenes con scroll individual
      await page.evaluate(async () => {
        const imgs = Array.from(document.querySelectorAll('div.box-image img'));
        for (const img of imgs) {
          img.scrollIntoView({ behavior: 'instant', block: 'center' });
          await new Promise(r => setTimeout(r, 150)); // da tiempo a cargar
        }
      });

      await page.waitForFunction(() => {
        const imgs = Array.from(document.querySelectorAll('div.box-image img'));
        return imgs.length > 0 && imgs.every(img =>
          img.complete &&
          img.naturalHeight > 50 &&
          !img.src.startsWith('data:image/svg+xml')
        );
      }, { timeout: 10000 }).catch(() => {
        console.log('[SCRAPER] Timeout esperando imágenes, continuando...');
      });
      
      const products = await page.$$eval(
        baseSel,
        (items, config) => {
          return items.map(item => {
            const result = {};
            for (const field of config.schema.fields) {
              if (field.type === 'constant') {
                result[field.name] = field.value;
              } else if (field.type === 'url_extract') {
                const match = config.url.match(new RegExp(field.pattern));
                if (match && match[1]) {
                  let v = match[1];
                  if (field.transform) v = new Function('data', field.transform)(v);
                  result[field.name] = v;
                }
              } else {
                const el = item.querySelector(field.selector);
                if (el) {
                  if (field.type === 'text') {
                    result[field.name] = el.innerText.trim();
                  } else if (field.type === 'attribute') {
                    let v = el.getAttribute(field.attribute);
                    if (field.transform) v = new Function('data', field.transform)(v);
                    result[field.name] = v;
                  }
                }
              }
            }
            return result;
          });
        },
        { schema: siteConfig.extraction_config.params.schema, url: nextUrl }
      );
      const enriched = products.map(p => ({
        ...p,
        source_url: nextUrl,
        scraped_at: new Date().toISOString(),
        site_name: siteConfig.site_name
      }));
      results.push(...enriched);
      // Paginación: si hay config.pagination, úsala; si no, intenta Next dinámico
      let foundNext = false;
      if (siteConfig.pagination) {
        console.log(`[PAGINATION] Buscando siguiente página con selector "${siteConfig.pagination.selector}"`);
        const nextHandle = await page.$(siteConfig.pagination.selector);
        console.log(`[PAGINATION] nextHandle encontrado?: ${nextHandle !== null}`);
        if (nextHandle) {
          const href = await nextHandle.getAttribute(siteConfig.pagination.attribute);
          console.log(`[PAGINATION] href obtenido: ${href}`);
          if (href) {
            const resolved = href.startsWith('http') ? href : new URL(href, siteConfig.base_url).href;
            console.log(`[PAGINATION] URL siguiente resuelta: ${resolved}`);
            nextUrl = resolved;
            pageNum++;
            foundNext = true;
            await page.waitForTimeout(500);
          } else {
            console.log('[PAGINATION] El elemento existe pero no tiene href → finalizando paginación');
            nextUrl = null;
          }
        } else {
          console.log('[PAGINATION] No hay enlace "Next" → finalizando paginación');
          nextUrl = null;
        }
      }
      if (!foundNext && !siteConfig.pagination) {
        // fallback: intentar Next dinámico
        const nextHref = await page.$eval(
          'a.next.page-number[aria-label="Next"]',
          el => el.getAttribute('href'),
        ).catch(() => null);
        if (nextHref) {
          const resolved = nextHref.startsWith('http') ? nextHref : new URL(nextHref, siteConfig.base_url).href;
          console.log(`[PAGINATION][fallback] Next encontrado: ${resolved}`);
          nextUrl = resolved;
          pageNum++;
          await page.waitForTimeout(500);
        } else {
          console.log('[PAGINATION][fallback] No se encontró botón Next → finalizando paginación');
          nextUrl = null;
        }
      }
    }
    await page.close();
    return results;
  } catch (err) {
    console.error(`[ERROR] scrapeUrl failed on ${url}:`, err.message);
    if (page) await page.close();
    return [];
  }
}

app.post('/scrape', async (req, res) => {
  try {
    if (!req.body.sites || !Array.isArray(req.body.sites)) {
      return res.status(400).json({
        success: false,
        error: 'El campo "sites" es requerido y debe ser un array',
        example: { sites: ["fancyyou"] }
      });
    }
    const siteConfigs = Object.fromEntries(
      Object.entries(loadSiteConfigs())
        .filter(([key]) => req.body.sites.includes(key))
    );
    if (Object.keys(siteConfigs).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Ninguno de los sitios solicitados existe',
        available_sites: Object.keys(loadSiteConfigs())
      });
    }
    const results = {};
    for (const [siteName, siteConfig] of Object.entries(siteConfigs)) {
      console.log(`[SCRAPER] Processing site: ${siteConfig.site_name}`);
      const browser = await chromium.launch({
        headless: siteConfig.crawler_params.headless
      });
      const context = await browser.newContext({
        viewport: siteConfig.crawler_params.defaultViewport,
        userAgent: siteConfig.crawler_params.args[0].replace('--user-agent=', '')
      });
      context.on('console', msg => {
        console.log(`[BROWSER LOG] ${msg.type()}: ${msg.text()}`);
      });
      if (siteConfig.auth_config) {
        const page = await context.newPage();
        await performLogin(page, siteConfig.auth_config);
        await page.close();
      }
      // Descubrir categorías/URLs
      let urls = req.body.urls?.[siteName];
      if (!urls) {
        if (siteConfig.use_predefined_urls && siteConfig.urls) {
          urls = siteConfig.urls;
        } else if (siteConfig.categories_config) {
          urls = await discoverCategories(browser, siteConfig);
        } else {
          throw new Error('No se pudo determinar cómo obtener las URLs para ' + siteName);
        }
      }
      console.log(`[SCRAPER] Found ${urls.length} URLs for ${siteConfig.site_name}`);
      const allProducts = [];
      const batchSize = siteConfig.semaphore_count || 2;
      for (let i = 0; i < urls.length; i += batchSize) {
        const batch = urls.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map(url => scrapeUrl(browser, url, siteConfig, context))
        );
        batchResults.forEach(products => allProducts.push(...products));
        console.log(`[PROGRESS] ${siteName}: ${allProducts.length} products scraped (${Math.round((i + batch.length) / urls.length * 100)}%)`);
      }
      await browser.close();
      results[siteName] = {
        site_name: siteConfig.site_name,
        total_products: allProducts.length,
        products: allProducts,
        scraping_config: {
          total_urls: urls.length,
          schema_name: siteConfig.extraction_config.params.schema.name,
          headless: siteConfig.crawler_params.headless
        }
      };
    }
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      sites: results
    });
  } catch (error) {
    console.error('[ERROR] Error general:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/sites', (_, res) => {
  const configs = loadSiteConfigs();
  res.json(Object.keys(configs).map(key => ({
    id: key,
    name: configs[key].site_name,
    base_url: configs[key].base_url,
    requires_auth: !!configs[key].auth_config
  })));
});

app.get('/', (_, res) => res.send('Playwright Scraper API running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] Listening on port ${PORT}`);
}); 