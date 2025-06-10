// 📁 server.js
import express from 'express';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());

// Crear directorio para screenshots si no existe
if (!fs.existsSync('./screenshots')) {
  fs.mkdirSync('./screenshots');
}

// Cargar todas las configuraciones de sitios
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
    // Navegar a la página de inicio
    await page.goto(authConfig.login_url);
    
    // Hacer clic en el botón de login para abrir el modal
    await page.click(authConfig.login_button_selector);
    console.log('[AUTH] Modal de login abierto');

    // Esperar a que aparezcan los campos del formulario
    await page.waitForSelector(authConfig.form_selectors.username);
    await page.waitForSelector(authConfig.form_selectors.password);

    // Llenar el formulario
    await page.fill(authConfig.form_selectors.username, authConfig.credentials.username);
    await page.fill(authConfig.form_selectors.password, authConfig.credentials.password);
    console.log('[AUTH] Credenciales ingresadas');

    // Enviar el formulario
    await page.click(authConfig.submit_button);
    
    // Esperar a que el login sea exitoso
    await page.waitForSelector(authConfig.success_check.selector, { 
      timeout: authConfig.success_check.timeout 
    });
    
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
    await page.goto(siteConfig.base_url, {
      waitUntil: 'networkidle',
      timeout: 60000
    });

    // Wait for dynamic content to load
    await page.waitForTimeout(2000);

    const categories = await page.$$eval(
      siteConfig.categories_config.selector,
      (elements, config) => {
        return elements
          .map(el => el.getAttribute(config.attribute))
          .filter(href => {
            if (!href || !href.includes(config.base_path)) return false;
            
            // Exclude non-product URLs
            const excludedPaths = [
              '/ubicación',
              '/contacto',
              '/nosotros',
              '/politicas',
              '/terminos',
              '/carrito',
              '/checkout',
              '/cuenta'
            ];
            
            return !excludedPaths.some(path => 
              href.toLowerCase().includes(path.toLowerCase())
            );
          })
          .filter((href, index, self) => self.indexOf(href) === index); // Remove duplicates
      },
      siteConfig.categories_config
    );

    console.log(`[DISCOVERY] Found ${categories.length} category URLs`);
    await page.close();
    
    return categories
      .map(path => {
        try {
          return new URL(path).toString();
        } catch {
          return new URL(path, siteConfig.base_url).toString();
        }
      })
      .filter((url, index, self) => self.indexOf(url) === index); // Remove duplicates again after URL normalization

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
    // Crear nueva página con manejo de errores
    try {
      page = await context.newPage();
    } catch (error) {
      console.log(`[SCRAPER] Error al crear nueva página: ${error.message}. Intentando crear nuevo contexto...`);
      context = await browser.newContext();
      page = await context.newPage();
    }

    // Configurar viewport
    try {
      await page.setViewportSize(siteConfig.crawler_params.defaultViewport);
    } catch (error) {
      console.log(`[SCRAPER] Error al configurar viewport: ${error.message}. Continuando...`);
    }

    console.log(`[SCRAPER] Navigating to ${url}`);
    
    // Carga inicial de la página
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (error) {
      console.log(`[SCRAPER] Initial load failed: ${error.message}`);
      await safeClosePage(page);
      return [];
    }

    // Esperar por productos con manejo de error simple
    try {
      await page.waitForSelector('ul.products li.product', { timeout: 45000 });
    } catch (err) {
      console.log(`[SCRAPER] No se encontró contenido en ${url}. Continuando...`);
      await safeClosePage(page);
      return [];
    }

    // Si llegamos aquí, hay productos, intentamos extraerlos
    try {
      const schema = siteConfig.extraction_config.params.schema;
      const products = await page.$$eval(schema.baseSelector, (items, config) => {
        return items.map(item => {
          const result = {};
          for (const field of config.schema.fields) {
            if (field.type === 'constant') {
              result[field.name] = field.value;
            } else if (field.type === 'url_extract') {
              const match = config.url.match(new RegExp(field.pattern));
              if (match && match[1]) {
                let value = match[1];
                if (field.transform) {
                  const transform = new Function('data', field.transform);
                  value = transform(value);
                }
                result[field.name] = value;
              }
            } else {
              const element = item.querySelector(field.selector);
              if (element) {
                if (field.type === 'text') {
                  result[field.name] = element.innerText.trim();
                } else if (field.type === 'attribute') {
                  let value = element.getAttribute(field.attribute);
                  if (field.transform) {
                    const transform = new Function('data', field.transform);
                    value = transform(value);
                  }
                  result[field.name] = value;
                }
              }
            }
          }
          return result;
        });
      }, { schema, url });

      // Enriquecer productos con metadata
      const enrichedProducts = products.map(product => ({
        ...product,
        source_url: url,
        scraped_at: new Date().toISOString(),
        site_name: siteConfig.site_name
      }));

      await safeClosePage(page);
      return enrichedProducts;
    } catch (error) {
      console.error(`[ERROR] Failed to extract products from ${url}:`, error);
      await safeClosePage(page);
      return [];
    }
  } catch (error) {
    console.error(`[ERROR] Unexpected error in ${url}:`, error);
    await safeClosePage(page);
    return [];
  }
}

// Función auxiliar para cerrar página de forma segura
async function safeClosePage(page) {
  try {
    if (page && !page.isClosed()) {
      await page.close();
    }
  } catch (error) {
    console.log('[SCRAPER] Error al cerrar página:', error.message);
  }
}

app.post('/scrape', async (req, res) => {
  try {
    // Validar el formato del request body
    if (!req.body.sites || !Array.isArray(req.body.sites)) {
      return res.status(400).json({
        success: false,
        error: 'El campo "sites" es requerido y debe ser un array',
        example: {
          sites: ["fancyyou"]
        }
      });
    }

    const siteConfigs = Object.fromEntries(
      Object.entries(loadSiteConfigs())
        .filter(([key]) => req.body.sites.includes(key))
    );

    // Validar que los sitios solicitados existan
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

      // Crear un contexto compartido para mantener la sesión
      const context = await browser.newContext({
        viewport: siteConfig.crawler_params.defaultViewport,
        userAgent: siteConfig.crawler_params.args[0].replace('--user-agent=', '')
      });

      // Habilitar logs del navegador
      context.on('console', msg => {
        console.log(`[BROWSER LOG] ${msg.type()}: ${msg.text()}`);
      });

      // Realizar login si es necesario
      if (siteConfig.auth_config) {
        const page = await context.newPage();
        await performLogin(page, siteConfig.auth_config);
        await page.close();
      }

      // Descubrir categorías si no se proporcionan URLs específicas
      const urls = req.body.urls?.[siteName] || 
        (siteConfig.use_predefined_urls ? siteConfig.urls : await discoverCategories(browser, siteConfig));
      console.log(`[SCRAPER] Found ${urls.length} URLs for ${siteConfig.site_name}`);

      const allProducts = [];
      const batchSize = siteConfig.semaphore_count;
      
      // Procesar URLs en lotes
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
