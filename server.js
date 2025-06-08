// 📁 server.js
import express from 'express';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());

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
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
  } catch (error) {
    console.error(`[GOTO ERROR] Could not load ${siteConfig.base_url}`);
    throw error;
  }
  
  const categories = await page.$$eval(
    siteConfig.categories_config.selector,
    (elements, config) => elements
      .map(el => el.getAttribute(config.attribute))
      .filter(href => href && (!config.base_path || href.includes(config.base_path))),
    siteConfig.categories_config
  );

  await page.close();
  return categories.map(path => new URL(path, siteConfig.base_url).toString());
}

async function scrapeUrl(browser, url, siteConfig, context) {
  console.log(`[SCRAPER] Starting scrape on: ${url}`);
  const page = await context.newPage();
  await page.setViewportSize(siteConfig.crawler_params.defaultViewport);
  
  try {
    await page.goto(url, { waitUntil: 'networkidle' });

    // Ejecutar pre-actions
    for (const action of siteConfig.pre_actions) {
      if (action.type === 'waitForSelector') {
        await page.waitForSelector(action.selector, { timeout: action.timeout });
      } else if (action.type === 'goto') {
        await page.goto(action.url, { waitUntil: 'networkidle' });
      }
    }

    const schema = siteConfig.extraction_config.params.schema;
    const products = await page.$$eval(schema.baseSelector, (items, schema) => {
      return items.map(item => {
        const result = {};
        for (const field of schema.fields) {
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
        return result;
      });
    }, schema);

    // Agregar metadata a cada producto
    const enrichedProducts = products.map(product => ({
      ...product,
      source_url: url,
      scraped_at: new Date().toISOString(),
      site_name: siteConfig.site_name
    }));

    await page.close();
    return enrichedProducts;
  } catch (error) {
    console.error(`[ERROR] Failed to scrape ${url}:`, error);
    await page.close();
    return [];
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
        headless: true
      });

      // Crear un contexto compartido para mantener la sesión
      const context = await browser.newContext();

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
      
      // Process URLs in batches
      for (let i = 0; i < urls.length; i += batchSize) {
        const batch = urls.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map(url => scrapeUrl(browser, url, siteConfig, context))
        );
        
        for (const products of batchResults) {
          allProducts.push(...products);
        }

        // Log progress
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
    console.error('[ERROR]', error);
    res.status(500).json({ 
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
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
app.listen(PORT, () => console.log(`[SERVER] Listening on port ${PORT}`));
