import express from 'express';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json());

// Store de jobs en memoria (en producción usarías Redis o DB)
const jobs = new Map();

// Estados posibles de un job
const JobStatus = {
  PENDING: 'pending',
  RUNNING: 'running', 
  COMPLETED: 'completed',
  FAILED: 'failed'
};

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
    
    // Si hay login_button_selector, hacer click (para modales)
    console.log('[AUTH] login_button_selector:', authConfig.login_button_selector);
    if (authConfig.login_button_selector) {
      await page.click(authConfig.login_button_selector);
      console.log('[AUTH] Modal de login abierto');
    }
    
    // Esperar y llenar campos según configuración
    if (authConfig.form_selectors.username) {
      await page.waitForSelector(authConfig.form_selectors.username, { timeout: 10000 });
      await page.fill(authConfig.form_selectors.username, authConfig.credentials.username);
    }
    
    if (authConfig.form_selectors.password) {
      await page.waitForSelector(authConfig.form_selectors.password, { timeout: 10000 });
      await page.fill(authConfig.form_selectors.password, authConfig.credentials.password);
    }
    
    console.log('[AUTH] Credenciales ingresadas');
    await page.click(authConfig.submit_button);
    
    // Esperar un poco más para que carguen los productos después del login
    await page.waitForTimeout(3000);
    
              await page.waitForSelector(authConfig.success_check.selector, { timeout: authConfig.success_check.timeout });
          console.log('[AUTH] Login exitoso');
          
          // Esperar un poco más para que la página se estabilice
          await page.waitForTimeout(2000);
          return true;
  } catch (error) {
    console.error('[AUTH] Error en el proceso de login:', error.message);
    // No lanzar error, solo retornar false para continuar sin login
    return false;
  }
}

async function discoverCategories(browser, siteConfig) {
  console.log(`[DISCOVERY] Finding categories for ${siteConfig.site_name}`);
  const page = await browser.newPage();
  
  // Bloquear recursos pesados para acelerar descubrimiento
  await page.route('**/*', (route) => {
    return ['image', 'stylesheet', 'font', 'media'].includes(route.request().resourceType())
      ? route.abort()
      : route.continue();
  });

  if (siteConfig.auth_config) {
    const page = await browser.newPage();
    const loginSuccess = await performLogin(page, siteConfig.auth_config);
    if (!loginSuccess) {
      console.log('[AUTH] Login falló, continuando sin autenticación...');
    }
    await page.close();
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
            const response = await page.goto(nextPageUrl, { waitUntil: 'networkidle', timeout: 10000 });
            
            // Detectar 404 inmediatamente
            if (response && response.status() === 404) {
              console.log(`[DISCOVERY][${catUrl}] Página 404 detectada: ${nextPageUrl}, terminando paginación`);
              nextPageUrl = null;
              break;
            }
            
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
    
    // Bloquear recursos pesados para acelerar carga (pero permitir JS)
    await page.route('**/*', (route) => {
      return ['image', 'stylesheet', 'font', 'media'].includes(route.request().resourceType())
        ? route.abort()
        : route.continue();
    });
    
    let nextUrl = url;
    let pageNum = 1;
    const results = [];
    while (nextUrl) {
      console.log(`[SCRAPER] Page ${pageNum} → ${nextUrl}`);
      try {
        const response = await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // Detectar 404 inmediatamente
        if (response && response.status() === 404) {
          console.log(`[SCRAPER] Página 404 detectada: ${nextUrl}, terminando paginación`);
          nextUrl = null;
          continue;
        }
        
        // Detectar si necesita login (página redirige a login)
        if (response && response.url().includes('/mi-cuenta/') && !nextUrl.includes('/mi-cuenta/')) {
          console.log(`[SCRAPER] Sesión expirada detectada, intentando re-login...`);
          if (siteConfig.auth_config) {
            const loginSuccess = await performLogin(page, siteConfig.auth_config);
            if (loginSuccess) {
              // Reintentar la página original
              const retryResponse = await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
              if (retryResponse && retryResponse.status() === 404) {
                console.log(`[SCRAPER] Página 404 después de re-login: ${nextUrl}, terminando paginación`);
                nextUrl = null;
                continue;
              }
            }
          }
        }
        
      } catch (error) {
        console.log(`[SCRAPER] Error cargando ${nextUrl}: ${error.message}, terminando paginación`);
        nextUrl = null;
        continue;
      }

      const baseSel = siteConfig.extraction_config.params.schema.baseSelector;
      try {
        await page.waitForSelector(baseSel, { timeout: 8000 }); // Aumentado de 5000 a 8000
      } catch (error) {
        // Retry con scroll para activar lazy loading
        console.log(`[SCRAPER] Primer intento falló, intentando con scroll...`);
        try {
          await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight / 2);
          });
          await page.waitForTimeout(2000);
          await page.waitForSelector(baseSel, { timeout: 5000 });
          console.log(`[SCRAPER] Productos encontrados después del scroll`);
        } catch (retryError) {
          console.log(`[SCRAPER] No se encontraron productos en ${nextUrl} (timeout + retry), terminando paginación`);
          nextUrl = null;
          continue;
        }
      }

      // Verificar si hay productos en la página
      const productCount = await page.$$eval(baseSel, els => els.length);
      if (productCount === 0) {
        // Verificar selectores alternativos comunes antes de dar up
        const altSelectors = [
          'div.product',
          'article.product',
          '.woocommerce-loop-product',
          '.product-item'
        ];
        
        let foundAlt = false;
        for (const altSel of altSelectors) {
          const altCount = await page.$$eval(altSel, els => els.length).catch(() => 0);
          if (altCount > 0) {
            console.log(`[SCRAPER] Productos encontrados con selector alternativo: ${altSel} (${altCount} productos)`);
            foundAlt = true;
            break;
          }
        }
        
        if (!foundAlt) {
          console.log(`[SCRAPER] Página vacía detectada en ${nextUrl}, terminando paginación`);
          nextUrl = null;
          continue;
        }
      }

      console.log(`[SCRAPER] Encontrados ${productCount} productos en página ${pageNum}`);
      
      // Debug: verificar si los elementos existen
      console.log(`[DEBUG] Product count: ${productCount}`);
      console.log(`[DEBUG] Base selector: ${baseSel}`);
      
      if (productCount > 0) {
        const sampleElement = await page.$(baseSel);
        if (sampleElement) {
          const html = await sampleElement.innerHTML();
          console.log(`[DEBUG] Sample element HTML: ${html.substring(0, 200)}...`);
        }
        
        // Verificar si hay elementos con los selectores específicos
        const titleElements = await page.$$('h1');
        const priceElements = await page.$$('strong.caja_precio_noimptk');
        const imageElements = await page.$$('img.img-responsive');
        
        console.log(`[DEBUG] Found ${titleElements.length} h1 elements`);
        console.log(`[DEBUG] Found ${priceElements.length} price elements`);
        console.log(`[DEBUG] Found ${imageElements.length} image elements`);
      } else {
        console.log(`[DEBUG] No products found with selector: ${baseSel}`);
        
        // Verificar si hay elementos similares
        const allDivs = await page.$$('div');
        console.log(`[DEBUG] Total div elements: ${allDivs.length}`);
        
        const cajaProductoDivs = await page.$$('div[class*="caja_producto"]');
        console.log(`[DEBUG] Divs with caja_producto in class: ${cajaProductoDivs.length}`);
      }
      
      // Comentado temporalmente para evitar bucle infinito
      // // Forzar carga de imágenes con scroll individual
      // await page.evaluate(async () => {
      //   const imgs = Array.from(document.querySelectorAll('div.box-image img'));
      //   for (const img of imgs) {
      //     img.scrollIntoView({ behavior: 'instant', block: 'center' });
      //     await new Promise(r => setTimeout(r, 300)); // reducido de 150ms a 100ms
      //   }
      // });

      // // Espera rápida para imágenes (500ms)
      // await page.waitForFunction(() => {
      //   const imgs = Array.from(document.querySelectorAll('div.box-image img'));
      //   return imgs.length > 0;
      // }, { timeout: 500 }).catch(() => {
      //   // Continúa sin esperar imágenes
      // });
      
              const products = await page.$$eval(
          baseSel,
          (items, config) => {
            // Limitar productos si se especifica max_products
            const maxProducts = config.max_products || items.length;
            const limitedItems = items.slice(0, maxProducts);
            
            console.log(`[DEBUG] Processing ${limitedItems.length} products (limited from ${items.length})`);
            
            return limitedItems.map(item => {
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
                          let v = el.innerText.trim();
                          if (field.transform) v = new Function('data', 'url', 'element', field.transform)(v, config.url, el);
                          result[field.name] = v;
                      } else if (field.type === 'attribute') {
                          let v = el.getAttribute(field.attribute);
                          if (field.transform) v = new Function('data', 'url', 'element', field.transform)(v, config.url, el);
                          result[field.name] = v;
                      }
                    }
                }
              }
              return result;
            });
          },
                  { 
            schema: siteConfig.extraction_config.params.schema, 
            url: nextUrl,
            max_products: siteConfig.max_products
          }
      );
      const enriched = products.map(p => ({
        ...p,
        source_url: nextUrl,
        scraped_at: new Date().toISOString(),
        site_name: siteConfig.site_name
      }));
      results.push(...enriched);
      // Paginación: si hay config.pagination, úsala; si no, intenta Next dinámico
      console.log(`[DEBUG] Checking pagination. pageNum: ${pageNum}, max_pages: ${siteConfig.pagination?.max_pages}`);
      
      // Verificar si hemos alcanzado el máximo de páginas
      if (siteConfig.pagination && siteConfig.pagination.max_pages && pageNum >= siteConfig.pagination.max_pages) {
        console.log(`[DEBUG] Reached max pages (${siteConfig.pagination.max_pages}), stopping pagination`);
        nextUrl = null;
      } else {
        let foundNext = false;
        if (siteConfig.pagination && siteConfig.pagination.selector) {
          const nextHandle = await page.$(siteConfig.pagination.selector);
          if (nextHandle) {
            const href = await nextHandle.getAttribute(siteConfig.pagination.attribute);
            if (href) {
              const resolved = href.startsWith('http') ? href : new URL(href, siteConfig.base_url).href;
              nextUrl = resolved;
              pageNum++;
              foundNext = true;
              await page.waitForTimeout(50);
            } else {
              nextUrl = null;
            }
          } else {
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
            nextUrl = resolved;
            pageNum++;
            await page.waitForTimeout(50);
          } else {
            nextUrl = null;
          }
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

// Crear un nuevo job de scraping (asíncrono)
app.post('/scrape', async (req, res) => {
  try {
    if (!req.body.sites || !Array.isArray(req.body.sites)) {
      return res.status(400).json({
        success: false,
        error: 'El campo "sites" es requerido y debe ser un array',
        example: { sites: ["fancyyou"] }
      });
    }

    const jobId = uuidv4();
    const job = {
      id: jobId,
      status: JobStatus.PENDING,
      sites: req.body.sites,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      progress: {
        current_site: null,
        current_site_index: 0,
        total_sites: req.body.sites.length,
        current_url: null,
        current_url_index: 0,
        total_urls: 0,
        products_scraped: 0
      },
      results: {},
      error: null
    };

    jobs.set(jobId, job);

    // Iniciar el scraping en background
    runScrapingJob(jobId).catch(error => {
      const job = jobs.get(jobId);
      if (job) {
        job.status = JobStatus.FAILED;
        job.error = error.message;
        job.completed_at = new Date().toISOString();
      }
    });

    res.json({
      success: true,
      job_id: jobId,
      status: JobStatus.PENDING,
      message: 'Scraping job iniciado. Use GET /status/:jobId para consultar el progreso.'
    });

  } catch (error) {
    console.error('[ERROR] Error creando job:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Consultar estado de un job
app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  
  if (!job) {
    return res.status(404).json({
      success: false,
      error: 'Job no encontrado'
    });
  }

  res.json({
    success: true,
    job_id: job.id,
    status: job.status,
    progress: job.progress,
    created_at: job.created_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    results: job.status === JobStatus.COMPLETED ? job.results : null,
    error: job.error
  });
});

// Listar todos los jobs
app.get('/jobs', (req, res) => {
  const allJobs = Array.from(jobs.values()).map(job => ({
    id: job.id,
    status: job.status,
    sites: job.sites,
    created_at: job.created_at,
    progress: job.progress
  }));

  res.json({
    success: true,
    jobs: allJobs
  });
});

// Función principal de scraping que se ejecuta en background
async function runScrapingJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = JobStatus.RUNNING;
  job.started_at = new Date().toISOString();

  const siteConfigs = Object.fromEntries(
    Object.entries(loadSiteConfigs())
      .filter(([key]) => job.sites.includes(key))
  );

  if (Object.keys(siteConfigs).length === 0) {
    throw new Error('Ninguno de los sitios solicitados existe');
  }

  let siteIndex = 0;
  for (const [siteName, siteConfig] of Object.entries(siteConfigs)) {
    job.progress.current_site = siteName;
    job.progress.current_site_index = siteIndex;
    
    console.log(`[JOB ${jobId}] Processing site: ${siteConfig.site_name}`);
    
    await runSiteScraping(jobId, siteName, siteConfig);
    siteIndex++;
  }

  job.status = JobStatus.COMPLETED;
  job.completed_at = new Date().toISOString();
}

// Función para scrapear un sitio específico con actualización de progreso
async function runSiteScraping(jobId, siteName, siteConfig) {
  const job = jobs.get(jobId);
  if (!job) return;

  const browser = await chromium.launch({
    headless: siteConfig.crawler_params.headless
  });
  
  const context = await browser.newContext({
    viewport: siteConfig.crawler_params.defaultViewport,
    userAgent: siteConfig.crawler_params.args[0].replace('--user-agent=', '')
  });

  try {
    // Login si es necesario
    if (siteConfig.auth_config) {
      const page = await context.newPage();
      const loginSuccess = await performLogin(page, siteConfig.auth_config);
      if (!loginSuccess) {
        console.log('[AUTH] Login falló, continuando sin autenticación...');
      }
      await page.close();
    }

    // Obtener URLs
    let urls;
    if (siteConfig.use_predefined_urls && siteConfig.urls) {
      urls = siteConfig.urls;
    } else if (siteConfig.categories_config) {
      urls = await discoverCategories(browser, siteConfig);
    } else {
      throw new Error('No se pudo determinar cómo obtener las URLs para ' + siteName);
    }

    job.progress.total_urls = urls.length;
    console.log(`[JOB ${jobId}] Found ${urls.length} URLs for ${siteConfig.site_name}`);

    const allProducts = [];
    const batchSize = siteConfig.semaphore_count || 2;
    
    for (let i = 0; i < urls.length; i += batchSize) {
      const batch = urls.slice(i, i + batchSize);
      job.progress.current_url_index = i;
      
      const batchResults = await Promise.allSettled(
        batch.map(url => {
          job.progress.current_url = url;
          return scrapeUrl(browser, url, siteConfig, context);
        })
      );
      
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          allProducts.push(...result.value);
          job.progress.products_scraped = allProducts.length;
        } else {
          console.error(`[JOB ${jobId}] Failed to scrape ${batch[index]}: ${result.reason}`);
        }
      });
      
      // Delay entre batches
      const delay = siteConfig.request_delay || 500;
      if (i + batchSize < urls.length) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    job.results[siteName] = {
      site_name: siteConfig.site_name,
      total_products: allProducts.length,
      products: allProducts,
      scraping_config: {
        total_urls: urls.length,
        schema_name: siteConfig.extraction_config.params.schema.name,
        headless: siteConfig.crawler_params.headless
      }
    };

  } finally {
    await browser.close();
  }
}

// Endpoint legacy (síncrono) para compatibilidad
app.post('/scrape-sync', async (req, res) => {
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
        // Filtrar logs irrelevantes del bloqueo de recursos
        const text = msg.text();
        if (text.includes('net::ERR_FAILED') || text.includes('status of 404')) {
          return; // No mostrar estos errores normales
        }
        console.log(`[BROWSER LOG] ${msg.type()}: ${text}`);
      });
      if (siteConfig.auth_config) {
        const page = await context.newPage();
        const loginSuccess = await performLogin(page, siteConfig.auth_config);
        if (!loginSuccess) {
          console.log('[AUTH] Login falló, continuando sin autenticación...');
        }
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
      
      try {
        for (let i = 0; i < urls.length; i += batchSize) {
          const batch = urls.slice(i, i + batchSize);
          console.log(`[BATCH] Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(urls.length/batchSize)} (${batch.length} URLs)`);
          
          const batchResults = await Promise.allSettled(
            batch.map(url => scrapeUrl(browser, url, siteConfig, context))
          );
          
          batchResults.forEach((result, index) => {
            if (result.status === 'fulfilled') {
              allProducts.push(...result.value);
            } else {
              console.error(`[ERROR] Failed to scrape ${batch[index]}: ${result.reason}`);
            }
          });
          
          console.log(`[PROGRESS] ${siteName}: ${allProducts.length} products scraped (${Math.round((i + batch.length) / urls.length * 100)}%)`);
          
          // Delay mínimo entre batches
          const delay = siteConfig.request_delay || 500;
          if (i + batchSize < urls.length) {
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      } catch (error) {
        console.error(`[ERROR] Error processing batches for ${siteName}:`, error.message);
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