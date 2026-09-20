require('dotenv').config();

const http = require('http');
const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!');
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('G4Skins Telegram Bot');
  }
});

server.listen(PORT, () => {
  console.log(`Healthcheck server listening on port ${PORT}`);
});

const { Telegraf, Markup } = require('telegraf');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const puppeteerCore = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

puppeteer.use(StealthPlugin());

// Railway ustawia RAILWAY_ENVIRONMENT
const isProduction = !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';

// Konfiguracja Puppeteer
const getPuppeteerConfig = async () => {
  if (isProduction) {
    return {
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    };
  } else {
    // Lokalne ustawienia (Windows)
    return {
      headless: false,
      args: ['--no-sandbox']
    };
  }
};

// Logger
const logger = {
  info: (...args) => console.log(new Date().toISOString(), '[INFO]', ...args),
  error: (...args) => console.error(new Date().toISOString(), '[ERROR]', ...args),
  warn: (...args) => console.warn(new Date().toISOString(), '[WARN]', ...args)
};

// Debug
logger.info('🔍 Token załadowany:', process.env.TELEGRAM_BOT_TOKEN ? 'TAK' : 'NIE');

if (!process.env.TELEGRAM_BOT_TOKEN) {
  logger.error('❌ BŁĄD: Brak TELEGRAM_BOT_TOKEN w pliku .env');
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Połączenie z MongoDB - ASYNC/AWAIT
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/dailybot', {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000
    });

    logger.info('✅ Połączono z MongoDB');
    return true;
  } catch (err) {
    logger.error('❌ Błąd MongoDB:', err);
    return false;
  }
}

// Schematy MongoDB
const userSchema = new mongoose.Schema({
  telegramId: { type: String, unique: true },
  steamUsername: String,
  steamPassword: String,
  familyViewPin: String,
  autoOpenEnabled: { type: Boolean, default: false },
  nextCaseTime: { type: Number, default: null }
});

const sessionSchema = new mongoose.Schema({
  telegramId: { type: String, unique: true },
  cookies: [Object]
});

const User = mongoose.model('User', userSchema);
const Session = mongoose.model('Session', sessionSchema);

// ====== KONFIGURACJA TIMEOUTS & LIMITS ======
const CONFIG = {
  // Memory management
  MAX_ACTIVE_SESSIONS: 50, // Maksymalna liczba równoczesnych sesji
  SESSION_IDLE_TIMEOUT: 30 * 60 * 1000, // 30 minut
  CLEANUP_INTERVAL: 10 * 60 * 1000, // 10 minut

  // Puppeteer timeouts
  BROWSER_LAUNCH_TIMEOUT: 30000,
  PAGE_LOAD_TIMEOUT: 30000,
  ELEMENT_WAIT_TIMEOUT: 10000,

  // URLs
  URLS: {
    G4SKINS_DAILY: 'https://g4skins.com/daily-case/open',
    G4SKINS_API_INVENTORY: 'https://api.g4skins.com/v2/user/inventory'
  }
};

// Struktura: { telegramId: { browser, page, username, loginMethod, isLoggedIn, autoOpenTimeout } }
const activeSessions = new Map();
const sessionCreationTime = new Map();
const autoOpenLocks = new Map();

// ====== AUTO-CLEANUP STARYCH SESJI ======
async function cleanupIdleSessions() {
  const now = Date.now();
  const sessionsToDelete = [];

  // OCHRONA: Jeśli przekroczono limit sesji, usuń najstarsze
  if (activeSessions.size > CONFIG.MAX_ACTIVE_SESSIONS) {
    logger.warn(`⚠️ Przekroczono limit sesji (${activeSessions.size}/${CONFIG.MAX_ACTIVE_SESSIONS}), czyszczę najstarsze...`);

    const sortedByAge = Array.from(activeSessions.keys())
      .map(userId => ({ userId, createdTime: sessionCreationTime.get(userId) || 0 }))
      .sort((a, b) => a.createdTime - b.createdTime);

    const toRemove = activeSessions.size - CONFIG.MAX_ACTIVE_SESSIONS;
    for (let i = 0; i < toRemove; i++) {
      const { userId } = sortedByAge[i];
      const session = activeSessions.get(userId);

      if (!session?.autoOpenTimeout) {
        sessionsToDelete.push(userId);
      }
    }
  }

  // Normalne czyszczenie idle sesji
  for (const [userId, session] of activeSessions.entries()) {
    const createdTime = sessionCreationTime.get(userId) || 0;
    const idleTime = now - createdTime;

    if (session.autoOpenTimeout) {
      // Jeśli sesja ma aktywny AutoOpen, ale przeglądarka 'wisi' nieaktywna zbyt długo – zamknij ją (oszczędność RAM)
      if (session.browser && idleTime > CONFIG.SESSION_IDLE_TIMEOUT) {
        logger.info(`🧹 [${userId}] Zamykam przeglądarkę oczekującą na AutoOpen (oszczędzanie RAM)`);
        try { await session.browser.close(); } catch(e) {}
        session.browser = null;
        session.page = null;
      }
      continue;
    }

    if (idleTime > CONFIG.SESSION_IDLE_TIMEOUT) {
      logger.info(`🧹 [${userId}] Czyszczę idle session (${Math.round(idleTime / 60000)} min nieaktywna)`);
      sessionsToDelete.push(userId);
    }
  }

  // Zamknij i usuń sesje
  for (const userId of sessionsToDelete) {
    const session = activeSessions.get(userId);
    if (session?.browser) {
      try {
        await session.browser.close();
        logger.info(`🧹 [${userId}] Przeglądarka zamknięta przez auto-cleanup`);
      } catch (e) {
        logger.warn(`⚠️ [${userId}] Błąd w auto-cleanup:`, e.message);
      }
    }
    activeSessions.delete(userId);
    sessionCreationTime.delete(userId);
    autoOpenLocks.delete(userId);
  }

  if (activeSessions.size > 0) {
    logger.info(`💾 RAM: ${activeSessions.size} aktywnych sesji`);
  }
}

setInterval(cleanupIdleSessions, CONFIG.CLEANUP_INTERVAL);

function setSessionAndTrack(userId, session) {
  if (session?.browser && session?.page) {
    sessionCreationTime.set(userId, Date.now());
  }
  activeSessions.set(userId, session);
}

// ====== FUNKCJE POMOCNICZE ======

async function loadUser(userId) {
  try {
    if (mongoose.connection.readyState !== 1) {
      logger.warn('MongoDB nie jest połączony podczas loadUser');
      return null;
    }

    const user = await User.findOne({ telegramId: userId });

    if (user) {
      logger.info(`✅ Znaleziono użytkownika ${userId}:`, {
        username: user.steamUsername ? 'TAK' : 'NIE',
        pin: user.familyViewPin ? 'TAK' : 'NIE'
      });
    } else {
      logger.info(`ℹ️ Użytkownik ${userId} nie istnieje w bazie`);
    }

    return user;
  } catch (error) {
    logger.error('❌ Błąd ładowania użytkownika:', error.message);
    return null;
  }
}

async function saveUser(user) {
  try {
    if (mongoose.connection.readyState !== 1) {
      logger.warn('MongoDB nie jest połączony, czekam...');
      await new Promise(resolve => setTimeout(resolve, 2000));

      if (mongoose.connection.readyState !== 1) {
        throw new Error('MongoDB nie jest połączony!');
      }
    }

    const result = await User.findOneAndUpdate(
      { telegramId: user.telegramId },
      user,
      { upsert: true, new: true }
    );

    logger.info(`✅ Użytkownik ${user.telegramId} zapisany:`, {
      username: user.steamUsername ? 'TAK' : 'NIE',
      pin: user.familyViewPin ? 'TAK' : 'NIE'
    });

    return result;
  } catch (error) {
    logger.error('❌ Błąd zapisywania użytkownika:', error.message);
    throw error;
  }
}

async function loadSessionCookies(userId) {
  try {
    const session = await Session.findOne({ telegramId: userId });
    return session ? session.cookies : null;
  } catch (error) {
    logger.error('❌ Błąd ładowania cookies:', error.message);
    return null;
  }
}

async function saveSessionCookies(userId, cookies) {
  try {
    await Session.findOneAndUpdate({ telegramId: userId }, { cookies }, { upsert: true });
    logger.info(`💾 [${userId}] Cookies zapisane`);
  } catch (error) {
    logger.error('❌ Błąd zapisywania cookies:', error.message);
  }
}

const SELECTORS = {
  steam: {
    form: [
      '._2v60tM463fW0V7GDe92E5f',
      'form[class*="loginform"]',
      'form'
    ],
    usernameInput: [
      '._2GBWeup5cttgbTw8FM3tfx[type="text"]',
      'input[type="text"][class*="Input"]',
      'input[type="text"]'
    ],
    passwordInput: [
      '._2GBWeup5cttgbTw8FM3tfx[type="password"]',
      'input[type="password"][class*="Input"]',
      'input[type="password"]'
    ],
    submitButton: [
      'button.DjSvCZoKKfoNSmarsEcTS[type="submit"]',
      'button[type="submit"][class*="Submit"]',
      'button[type="submit"]'
    ]
  },
  familyView: {
    pinInput: [
      '._2YxW3WqLGy7hz_21m6KbGD[type="password"]',
      'input[type="password"][class*="qLGy"]',
      'input[type="password"]'
    ],
    okButton: [
      'button._2KPv6oWB6ZxjWuqyNp_edP.DialogButton',
      'button[class*="DialogButton"][class*="Primary"]',
      'button[type="submit"]'
    ],
    errorMessage: '._12jKU2kye0rjoTffWoi8IP',
    title: '._2B7Yoe-uA3HJOINTx5rV8-'
  },
  g4skins: {
    loginForm: '.login-form-content',
    checkbox: '.checkbox__input',
    steamButton: '.login-form-content-nav button'
  }
};

async function findElement(page, selectorArray, timeout = 10000) {
  for (const selector of selectorArray) {
    try {
      await page.waitForSelector(selector, { timeout: timeout / selectorArray.length });
      return selector;
    } catch (e) {
      continue;
    }
  }
  throw new Error(`Nie znaleziono elementu z selektorów: ${selectorArray.join(', ')}`);
}

async function findButtonByText(page, text, timeout = 10000) {
  try {
    const button = await page.waitForFunction(
      (searchText) => {
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'));
        return buttons.find(btn => btn.textContent.trim().toLowerCase().includes(searchText.toLowerCase()) ||
                                   btn.value && btn.value.trim().toLowerCase().includes(searchText.toLowerCase()));
      },
      { timeout },
      text
    );
    return button;
  } catch (e) {
    throw new Error(`Nie znaleziono przycisku z tekstem: ${text}`);
  }
}

// ====== LOGOWANIE ======

async function loginToSteam(ctx, loginMethod = 'password') {
  const userId = ctx.from.id.toString();
  let session = activeSessions.get(userId);

  try {
    if (!session || !session.browser) {
      const config = await getPuppeteerConfig();
      let browser;

      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          browser = isProduction ? await puppeteerCore.launch(config) : await puppeteer.launch({
            headless: false,
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-accelerated-2d-canvas',
              '--no-first-run',
              '--no-zygote',
              '--disable-gpu'
            ]
          });
          break;
        } catch (launchError) {
          logger.error(`❌ [${userId}] Błąd uruchamiania przeglądarki (próba ${attempt}/${maxRetries}):`, launchError.message);
          if (attempt === maxRetries) throw launchError;
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }

      const page = await browser.newPage();

      browser.on('disconnected', () => {
        logger.warn(`⚠️ [${userId}] Przeglądarka odłączona (crash lub zamknięcie)`);
        const currentSession = activeSessions.get(userId);
        if (currentSession) {
          currentSession.browser = null;
          currentSession.page = null;
          currentSession.isLoggedIn = false;
          setSessionAndTrack(userId, currentSession);
        }
      });

      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1366, height: 768 });

      const savedCookies = await loadSessionCookies(userId);
      if (savedCookies && Array.isArray(savedCookies)) {
        const cleanedCookies = savedCookies.map(({ partitionKey, ...rest }) => rest);
        await page.setCookie(...cleanedCookies);
        await page.goto(CONFIG.URLS.G4SKINS_DAILY, { waitUntil: 'networkidle2' });

        const stillLoggedIn = await page.evaluate(() => {
          return !document.querySelector('.login-form-content');
        });

        if (stillLoggedIn) {
          logger.info(`✅ [${userId}] Zalogowano automatycznie z cookies`);
          setSessionAndTrack(userId, { browser, page, isLoggedIn: true, loginMethod });
          await ctx.reply('✅ Zalogowano automatycznie z zapisanej sesji!');
          return true;
        }
      }

      session = { browser, page, isLoggedIn: false, loginMethod };
      setSessionAndTrack(userId, session);
    }

    const { page } = session;

    await ctx.reply('🔄 Rozpoczynam logowanie...');
    await page.goto('https://g4skins.com/daily-case/open', { waitUntil: 'networkidle2' });

    try {
      await page.waitForSelector(SELECTORS.g4skins.loginForm, { timeout: 10000 });
    } catch (e) {
      await ctx.reply('⚠️ Nie znaleziono formularza logowania, klikam przycisk login...');
      try {
        await page.click('button[class*="login"], .login-button');
      } catch (e2) {
        logger.warn(`⚠️ [${userId}] Standardowy przycisk nie działa, próbuję znaleźć link login...`);
        const loginElement = await page.evaluateHandle(() => {
          const elements = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]'));
          return elements.find(el => el.textContent && el.textContent.toLowerCase().includes('login'));
        });
        if (loginElement) {
          await loginElement.click();
        } else {
          throw new Error('Nie znaleziono żadnego elementu logowania');
        }
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    await ctx.reply('☑️ Zaznaczam checkboxy...');

    await page.waitForSelector(SELECTORS.g4skins.checkbox, { timeout: 5000 }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 1500));

    const checkboxes = await page.$$(SELECTORS.g4skins.checkbox);
    let clickedCount = 0;

    for (let i = 0; i < checkboxes.length; i++) {
      try {
        await checkboxes[i].click();
        clickedCount++;
        console.log(`[DEBUG] Checkbox ${i} kliknięty natywnie.`);
      } catch (err) {
        console.log(`[DEBUG] Błąd natywnego kliknięcia checkboxa ${i}, próbuję kliknąć rodzica (wrapper)...`);

        await page.evaluate((el) => {
          if (el.labels && el.labels.length > 0) {
            el.labels[0].click();
          } else if (el.parentElement) {
            el.parentElement.click();
          } else {
            el.click();
          }
        }, checkboxes[i]);

        clickedCount++;
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    logger.info(`[DEBUG] Znaleziono checkboxów: ${checkboxes.length}, Kliknięto pomyślnie: ${clickedCount}`);
    await ctx.reply(`☑️ Zaznaczono checkboxy: ${clickedCount}/${checkboxes.length}`);

    await new Promise(resolve => setTimeout(resolve, 2000));

    await ctx.reply('🎮 Przechodzę do Steam...');

    const steamButtonDebug = await page.evaluate(() => {
      const buttons = document.querySelectorAll('.login-form-content-nav button, .login-form-content button');
      return Array.from(buttons).map((btn, i) => ({
        index: i,
        text: btn.textContent?.trim(),
        disabled: btn.disabled || btn.hasAttribute('disabled'),
        classes: btn.className
      }));
    });
    logger.info(`[DEBUG] Dostępne przyciski Steam: ${JSON.stringify(steamButtonDebug)}`);

    await page.waitForFunction(
      () => {
        const btn = document.querySelector('.login-form-content-nav button:not([disabled])') ||
                    document.querySelector('.login-form-content-nav-login:not([disabled])');
        return !!btn;
      },
      { timeout: 10000 }
    );

    await page.evaluate(() => {
      const btn = document.querySelector('.login-form-content-nav button:not([disabled])') ||
                  document.querySelector('.login-form-content-nav-login:not([disabled])');
      if (btn) {
        btn.click();
        console.log('[DEBUG] Kliknięto przycisk Steam');
      }
    });

    await page.waitForFunction(
      () => window.location.href.includes('steamcommunity.com') || window.location.href.includes('steampowered.com'),
      { timeout: 15000 }
    );

    await findElement(page, SELECTORS.steam.form, 15000);
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (loginMethod === 'qr') {
      await handleQRLogin(ctx, page, userId);
    } else {
      await handlePasswordLogin(ctx, page, userId);
    }

    logger.info(`✅ [${userId}] Logowanie zakończone, przeglądarka pozostaje otwarta`);
    return true;

  } catch (error) {
    logger.error(`❌ [${userId}] Błąd logowania:`, error.message);
    await ctx.reply(`❌ Błąd logowania: ${error.message}`);
    return false;
  }
}

async function handlePasswordLogin(ctx, page, userId) {
  const user = await loadUser(userId);

  if (!user || !user.steamUsername || !user.steamPassword) {
    await ctx.reply('❌ Nie masz zapisanych danych Steam! Użyj /setsteam');
    throw new Error('Brak danych Steam');
  }

  await ctx.reply('🔐 Wypełniam dane logowania...');

  const usernameSelector = await findElement(page, SELECTORS.steam.usernameInput, 10000);
  await page.type(usernameSelector, user.steamUsername);
  await new Promise(resolve => setTimeout(resolve, 500));

  const passwordSelector = await findElement(page, SELECTORS.steam.passwordInput, 10000);
  await page.type(passwordSelector, user.steamPassword);
  await new Promise(resolve => setTimeout(resolve, 500));

  await ctx.reply('✅ Dane wprowadzone, klikam "Sign in"...');

  try {
    const submitSelector = await findElement(page, SELECTORS.steam.submitButton, 5000);
    await page.click(submitSelector);
  } catch (e) {
    logger.warn(`⚠️ [${userId}] Standardowe selektory nie działają, próbuję znaleźć przycisk po tekście...`);
    const loginButton = await findButtonByText(page, 'Sign in', 5000);
    await loginButton.click();
  }

  await ctx.reply('⏳ Czekam na odpowiedź Steam...');
}

async function handleQRLogin(ctx, page, userId) {
  await ctx.reply('📱 Tryb logowania QR - czekam na kod...');

  let lastQRSrc = null;
  let qrSendTimeout = null;
  let isFirstQR = true;

  try {
    await page.exposeFunction('onQRChange', async (qrSrc) => {
      if (qrSrc === lastQRSrc && !isFirstQR) {
        return;
      }

      lastQRSrc = qrSrc;

      if (qrSendTimeout) {
        clearTimeout(qrSendTimeout);
      }

      qrSendTimeout = setTimeout(async () => {
        logger.info(`🔄 [${userId}] Wysyłam ${isFirstQR ? 'pierwszy' : 'odświeżony'} QR kod`);
        isFirstQR = false;
        await sendQRCode(ctx, qrSrc, userId, page);
      }, 1000);
    });

    await page.evaluate(() => {
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
            const img = mutation.target;
            if (img.src && img.src.startsWith('blob:')) {
              window.onQRChange(img.src);
            }
          }
          if (mutation.type === 'childList') {
            mutation.addedNodes.forEach((node) => {
              if (node.tagName === 'IMG' && node.src && node.src.startsWith('blob:')) {
                window.onQRChange(node.src);
              }
            });
          }
        });
      });

      const qrImg = document.querySelector('img[src^="blob:"]');
      if (qrImg) {
        observer.observe(qrImg.parentElement || document.body, {
          attributes: true,
          subtree: true,
          childList: true,
          attributeFilter: ['src']
        });
        window.onQRChange(qrImg.src);
      }
    });

    await waitForRedirectOrGuard(ctx, page, userId);

  } catch (error) {
    logger.error(`❌ [${userId}] Błąd QR logowania:`, error.message);
    if (qrSendTimeout) clearTimeout(qrSendTimeout);
    throw error;
  }
}

async function sendQRCode(ctx, blobUrl, userId, page) {
  const session = activeSessions.get(userId);
  if (!session) {
    logger.warn(`⚠️ [${userId}] Sesja nie znaleziona`);
    return;
  }

  try {
    let base64 = null;

    try {
      const base64Result = await page.evaluate(async (url) => {
        try {
          const response = await fetch(url);
          if (!response.ok) return null;

          const blob = await response.blob();

          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const result = reader.result;
              if (result && typeof result === 'string') {
                resolve(result);
              } else {
                resolve(null);
              }
            };
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          });
        } catch (e) {
          return null;
        }
      }, blobUrl);

      base64 = base64Result;
    } catch (e) {
      logger.warn(`⚠️ [${userId}] Metoda fetch nie zadziałała:`, e.message);
    }

    if (!base64) {
      try {
        base64 = await page.evaluate(async (url) => {
          try {
            const img = new Image();
            img.crossOrigin = 'anonymous';

            return new Promise((resolve) => {
              img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                resolve(canvas.toDataURL('image/png'));
              };
              img.onerror = () => resolve(null);
              img.src = url;
            });
          } catch (e) {
            return null;
          }
        }, blobUrl);
      } catch (e) {
        logger.warn(`⚠️ [${userId}] Metoda canvas nie zadziałała:`, e.message);
      }
    }

    if (!base64) {
      logger.warn(`⚠️ [${userId}] Nie udało się skonwertować QR`);
      await ctx.reply('📱 Nie mogę wyświetlić QR kodu, ale jest on otwarty w przeglądarce.\nZeskanuj kod w aplikacji Steam Mobile.');
      return;
    }

    const base64Data = base64.split(',')[1];
    if (!base64Data) {
      throw new Error('Brak danych base64');
    }

    const buffer = Buffer.from(base64Data, 'base64');

    await ctx.replyWithPhoto(
      { source: buffer },
      {
        caption: '📱 Zeskanuj ten kod w aplikacji Steam Mobile',
        parse_mode: 'HTML'
      }
    );

    logger.info(`✅ [${userId}] QR kod wysłany`);

  } catch (error) {
    logger.error(`❌ [${userId}] Błąd wysyłania QR:`, error.message);
    await ctx.reply('⚠️ Nie mogę wysłać QR kodu - sprawdź czy QR jest widoczny w przeglądarce.');
  }
}

async function handleFamilyView(ctx, page, userId) {
  logger.info(`${userId}: Rozpoczynam obsługę Family View`);
  await ctx.reply('🔄 Obsługuję Family View - sprawdzam PIN...');

  const user = await loadUser(userId);
  if (!user || !user.familyViewPin) {
    await ctx.reply('⚠️ Nie masz zapisanego PIN-u Family View!\nUżyj komendy /setpin\nFormat: `PIN:1234`\n\nLub wpisz PIN ręcznie w przeglądarce.', { parse_mode: 'Markdown' });
    logger.warn(`${userId}: Brak zapisanego PIN-u Family View`);
    return false;
  }

  const pin = user.familyViewPin;
  logger.info(`${userId}: Użyję PIN ${pin.replace(/./g, '*')}`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    logger.info(`${userId}: Próba ${attempt}/3 obsługi Family View`);
    await ctx.reply(`🔄 Próba ${attempt}/3 - odświeżam stronę...`);

    try {
      if (attempt > 1) {
        await page.reload({ waitUntil: 'networkidle2' });
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      const familyViewExists = await page.evaluate(() => {
        const allText = document.body.innerText || document.body.textContent;
        const hasPinInput = !!document.querySelector('input[type="password"]');
        const hasText = allText.includes('Family View') || allText.includes('Enter your PIN');
        return hasPinInput || hasText;
      });

      if (!familyViewExists) {
        logger.info(`${userId}: Family View nie istnieje (już zniknął) - kontynuuję logowanie`);
        await ctx.reply('✅ Family View nie jest już wymagany - kontynuuję logowanie!');
        return true;
      }

      await new Promise(resolve => setTimeout(resolve, 2000));

      let pinInput = null;

      try {
        pinInput = await page.$('.\\32 YxW3WqLGy7hz21m6KbGD[type="password"]');
        if (pinInput) logger.info(`${userId}: PIN input znaleziony metoda 1 (klasa)`);
      } catch (e) { }

      if (!pinInput) {
        pinInput = await page.$('input[type="password"]');
        if (pinInput) logger.info(`${userId}: PIN input znaleziony metoda 2 (type)`);
      }

      if (!pinInput) {
        throw new Error('Nie znaleziono pola PIN');
      }

      await ctx.reply('⌨️ Wpisuję PIN...');

      await pinInput.click();
      await new Promise(resolve => setTimeout(resolve, 300));

      await page.evaluate((selector) => {
        const input = document.querySelector(selector);
        if (input) {
          input.value = '';
          input.focus();
        }
      }, 'input[type="password"]');

      for (const digit of pin) {
        await page.keyboard.type(digit);
        await new Promise(resolve => setTimeout(resolve, 150));
      }

      logger.info(`${userId}: PIN wpisany`);
      await new Promise(resolve => setTimeout(resolve, 500));

      let okButton = null;

      try {
        okButton = await page.$('button.\\32 KPv6oWB6ZxjWuqyNpedP');
        if (okButton) logger.info(`${userId}: OK button znaleziony metoda 1`);
      } catch (e) { }

      if (!okButton) {
        okButton = await page.evaluateHandle(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          return buttons.find(btn => btn.textContent.trim() === 'OK');
        });
        if (okButton) {
          okButton = okButton.asElement();
          if (okButton) {
            logger.info(`${userId}: OK button znaleziony metoda 2 (text)`);
          } else {
            okButton = null;
          }
        }
      }

      if (!okButton) {
        okButton = await page.$('button[type="submit"]');
        if (okButton) logger.info(`${userId}: OK button znaleziony metoda 3 (submit)`);
      }

      if (!okButton) {
        throw new Error('Nie znaleziono przycisku OK');
      }

      const isDisabled = await page.evaluate(btn => {
        return btn.classList.contains('Disabled') || btn.disabled;
      }, okButton);

      if (isDisabled) {
        logger.warn(`${userId}: Przycisk OK jest disabled, czekam...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      await ctx.reply('✔️ Klikam OK...');
      await okButton.click();
      logger.info(`${userId}: Przycisk OK kliknięty`);

      await new Promise(resolve => setTimeout(resolve, 3000));

      const hasError = await page.evaluate(() => {
        const allText = document.body.innerText || document.body.textContent;
        return allText.includes('correct PIN') || allText.includes('Nice try');
      });

      if (hasError) {
        logger.error(`${userId}: Nieprawidłowy PIN Family View (próba ${attempt}/3)`);
        if (attempt < 3) {
          await ctx.reply(`❌ PIN nieprawidłowy (próba ${attempt}/3). Próbuję ponownie...`);
          continue;
        } else {
          await ctx.reply('❌ PIN Family View jest nieprawidłowy po 3 próbach!\nZmień PIN komendą /setpin lub wpisz ręcznie.');
          return false;
        }
      }

      const familyViewGone = await page.evaluate(() => {
        const allText = document.body.innerText || document.body.textContent;
        return !allText.includes('Family View') && !allText.includes('Enter your PIN');
      });

      if (familyViewGone) {
        logger.info(`${userId}: Family View pomyślnie pominięty w próbie ${attempt}`);
        await ctx.reply('✅ Family View pominięty!');
        return true;
      }

      logger.warn(`${userId}: Family View status niejasny w próbie ${attempt}, czekam...`);
      await new Promise(resolve => setTimeout(resolve, 2000));

      if (attempt < 3) {
        continue;
      } else {
        logger.error(`${userId}: Family View nie został pominięty po 3 próbach`);
        await ctx.reply('❌ Nie udało się pominąć Family View po 3 próbach.');
        return false;
      }

    } catch (error) {
      logger.error(`${userId}: Błąd w próbie ${attempt}:`, error.message);
      if (attempt < 3) {
        await ctx.reply(`⚠️ Błąd w próbie ${attempt}, próbuję ponownie...`);
        continue;
      } else {
        await ctx.reply(`❌ Błąd po 3 próbach: ${error.message}`);
        return false;
      }
    }
  }

  return false;
}

async function waitForRedirectOrGuard(ctx, page, userId) {
  await ctx.reply('⏳ Czekam na zalogowanie (max 2 minuty)...');

  const maxWaitTime = 120000;
  const startTime = Date.now();
  let lastStatusTime = startTime;
  const session = activeSessions.get(userId);
  let familyViewAttempts = 0;

  const checkForFamilyView = async () => {
    const familyViewDetection = await page.evaluate(() => {
      const allText = document.body.innerText || document.body.textContent;
      const hasText = allText.includes('Family View') && allText.includes('Enter your PIN');
      const hasPinInput = !!document.querySelector('input[type="password"]');
      const hasResetLink = !!document.querySelector('a[href*="parental/requestrecovery"]');
      const hasError = allText.includes('correct PIN') || allText.includes('Nice try');

      const title = document.querySelector('div[class*="JEjgWHYD"], div[class*="B7Yoe"]');
      const hasFamilyTitle = title && title.textContent.includes('Family View');

      const isLoginPage = !window.location.href.includes('/openid/login');

      return {
        detected: (hasText && hasPinInput) || hasFamilyTitle || (hasError && hasPinInput) || hasResetLink,
        isLoginPage,
        debug: {
          url: window.location.href,
          hasText,
          hasPinInput,
          hasError,
          hasFamilyTitle,
          hasResetLink,
          textSample: allText.substring(0, 300)
        }
      };
    });

    return familyViewDetection;
  };

  try {
    while (Date.now() - startTime < maxWaitTime) {
      const currentUrl = await page.evaluate(() => window.location.href);

      if (currentUrl.includes('steamcommunity.com') || currentUrl.includes('steampowered.com')) {
        const familyCheck = await checkForFamilyView();

        logger.info(`🔍 [${userId}] Family View check:`, {
          url: currentUrl,
          detected: familyCheck.detected,
          debug: familyCheck.debug
        });

        if (familyCheck.detected) {
          familyViewAttempts++;
          logger.info(`👨‍👩‍👧 [${userId}] ✅ WYKRYTO Family View! (próba ${familyViewAttempts}/3)`);

          if (familyViewAttempts > 3) {
            logger.warn(`⚠️ [${userId}] Przekroczono limit prób Family View, kończę logowanie`);
            await ctx.reply('❌ Logowanie przerwane - zbyt wiele prób Family View.\n\nUstaw PIN komendą /setpin i spróbuj ponownie.');
            return false;
          }

          await ctx.reply('👨‍👩‍👧 Wykryto Family View - wpisuję PIN...');

          const handled = await handleFamilyView(ctx, page, userId);

          if (!handled) {
            await ctx.reply('❌ Logowanie przerwane z powodu Family View.\n\nUstaw PIN komendą /setpin i spróbuj ponownie zalogować się.');
            logger.error(`❌ [${userId}] Logowanie przerwane - brak PIN-u Family View`);
            return false;
          }

          await new Promise(resolve => setTimeout(resolve, 3000));
          continue;
        }
      }

      if (currentUrl.includes('steamcommunity.com/openid/login')) {
        logger.info(`${userId}: Wykryto stronę potwierdzenia OpenID`);

        const familyCheckBeforeClick = await checkForFamilyView();
        if (familyCheckBeforeClick.detected) {
          logger.info(`${userId}: Family View na stronie OpenID - obsługuję...`);
          await ctx.reply('🔐 Family View na stronie logowania...');
          await handleFamilyView(ctx, page, userId);
          await new Promise(resolve => setTimeout(resolve, 3000));
          continue;
        }

        const hasSignInButton = await page.evaluate(() => {
          return !!document.querySelector('input[type="submit"][id="imageLogin"], input[value="Sign In"], button[type="submit"]');
        });

        if (hasSignInButton) {
          logger.info(`${userId}: Znaleziono przycisk Sign In, klikam...`);

          if (!session.lastConfirmTime || Date.now() - session.lastConfirmTime > 10000) {
            await ctx.reply('✅ Potwierdzam logowanie przez Steam...');
            session.lastConfirmTime = Date.now();
          }

          if (!session.lastQrTime || Date.now() - session.lastQrTime > 45000) {
            await ctx.reply('📱 Zeskanuj ten kod...');
            session.lastQrTime = Date.now();
          }

          try {
            await new Promise(resolve => setTimeout(resolve, 1500));

            await page.evaluate(() => {
              const button = document.querySelector('input[type="submit"][id="imageLogin"]') ||
                            document.querySelector('input[value="Sign In"]') ||
                            document.querySelector('button[type="submit"]') ||
                            document.querySelector('input[type="submit"]');
              if (button) {
                button.click();
                return true;
              }

              const form = document.querySelector('form[name="openidForm"], form[name="loginForm"]');
              if (form) {
                form.submit();
                return true;
              }
              return false;
            });

            logger.info(`${userId}: Przycisk Sign In kliknięty`);
            await new Promise(resolve => setTimeout(resolve, 2000));

            logger.info(`${userId}: Sprawdzam czy po Sign In nie pojawił się Family View...`);
            await new Promise(resolve => setTimeout(resolve, 2000));

            const familyCheckAfterClick = await checkForFamilyView();
            if (familyCheckAfterClick.detected) {
              logger.info(`${userId}: Family View pojawił się PO kliknięciu Sign In!`);
              await ctx.reply('🔐 Family View po zalogowaniu - obsługuję...');
              await handleFamilyView(ctx, page, userId);
              await new Promise(resolve => setTimeout(resolve, 3000));
            }

          } catch (e) {
            logger.error(`${userId}: Błąd klikania Sign In:`, e.message);
            await ctx.reply('⚠️ Nie mogę automatycznie kliknąć - kliknij Sign In ręcznie');
          }
        } else {
          logger.warn(`${userId}: Nie znaleziono przycisku Sign In na stronie OpenID`);
          await ctx.reply('⚠️ Nie znaleziono przycisku Sign In - kliknij ręcznie w przeglądarce');
        }
      }

      if (currentUrl.includes('g4skins.com')) {
        logger.info(`✅ [${userId}] Przekierowano na G4Skins`);
        break;
      }

      if (currentUrl.includes('steampowered.com') || currentUrl.includes('steamcommunity.com/login')) {
        const hasGuardInput = await page.evaluate(() => {
          return !!document.querySelector('input[type="email"], input[type="text"][placeholder*="code"], input[class*="Guard"], input[name*="twofactor"]');
        });

        if (hasGuardInput) {
          logger.info(`🔐 [${userId}] Wykryto Steam Guard`);
          await ctx.reply('🔐 Wymagany kod Steam Guard!\n\nWpisz kod z aplikacji lub maila w przeglądarce.\n⏳ Czekam 2 minuty...');
        }
      }

      const now = Date.now();
      if (now - lastStatusTime > 30000) {
        const secondsLeft = Math.floor((maxWaitTime - (now - startTime)) / 1000);
        logger.info(`⏳ [${userId}] Czekam na zalogowanie... (${secondsLeft}s)`);
        lastStatusTime = now;
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    logger.info(`⏳ [${userId}] Czekam na ostateczne przekierowanie na g4skins...`);
    await page.waitForFunction(
      () => window.location.href.includes('g4skins.com'),
      { timeout: 30000 }
    );

    logger.info(`✅ [${userId}] Przekierowano, sprawdzam logowanie...`);

  } catch (error) {
    logger.error(`⚠️ [${userId}] Timeout:`, error.message);
    await ctx.reply(
      '⏰ Upłynął limit czasu oczekiwania.\n\n' +
      'Możesz dokończyć logowanie ręcznie w otwartej przeglądarce.\n' +
      'Użyj /logout aby zamknąć sesję lub /check aby sprawdzić status.'
    );
    return false;
  }

  try {
    await page.goto('https://g4skins.com/daily-case/open', { waitUntil: 'networkidle2', timeout: 15000 });

    const loggedIn = await page.evaluate(() => {
      return !document.querySelector('.login-form-content');
    });

    if (loggedIn) {
      const cookies = await page.cookies();
      saveSessionCookies(userId, cookies);

      if (session) {
        session.isLoggedIn = true;
        setSessionAndTrack(userId, session);
      }

      logger.info(`✅ [${userId}] Zalogowano pomyślnie`);
      await ctx.reply('✅ Zalogowano pomyślnie! Sesja zapisana.');
      return true;
    } else {
      await ctx.reply('⚠️ Logowanie wygląda na niezakończone. Spróbuj ponownie /login');
      return false;
    }
  } catch (error) {
    logger.error(`⚠️ [${userId}] Błąd weryfikacji:`, error.message);
    await ctx.reply('⚠️ Błąd przy weryfikacji logowania. Spróbuj /check');
    return false;
  }
}

// ====== G4SKINS API ======

async function checkDailyCase(ctx) {
  const userId = ctx.from.id.toString();
  let session = activeSessions.get(userId);

  const user = await loadUser(userId);
  const hasSteamCredentials = user && user.steamUsername && user.steamPassword;

  if (!session || !session.isLoggedIn || (session && !session.browser?.isConnected())) {
    if (hasSteamCredentials) {
      await ctx.reply('🔄 Nie jesteś zalogowany - automatyczne logowanie...');
      logger.info(`🔄 [${userId}] Automatyczne logowanie dla /check`);
      const loginSuccess = await loginToSteam(ctx, 'password');
      if (!loginSuccess) {
        return null;
      }
      session = activeSessions.get(userId);
    } else {
      await ctx.reply('❌ Nie jesteś zalogowany! Użyj /login lub najpierw zapisz dane Steam komendą /setsteam');
      return null;
    }
  }

  if (!session || !session.page || !session.browser) {
    logger.error(`❌ [${userId}] Sesja nie ma wymaganych właściwości (page/browser)`);
    await ctx.reply('❌ Błąd sesji! Spróbuj zalogować się ponownie /login');
    activeSessions.delete(userId);
    return null;
  }

  const { page, browser } = session;

  if (!browser.isConnected()) {
    await ctx.reply('❌ Przeglądarka została zamknięta! Zaloguj się ponownie /login');
    activeSessions.delete(userId);
    return null;
  }

  try {
    await page.goto('https://g4skins.com/daily-case/open', { waitUntil: 'networkidle2' });
    logger.info(`🔍 [${userId}] Sprawdzam daily case...`);

    const caseInfo = await page.evaluate(() => {
      return new Promise((resolve) => {
        let waited = 0;
        const maxWait = 2000;
        const step = 100;

        const interval = setInterval(() => {
          const container = document.querySelector('.top-options');
          const btn = container ? container.querySelector('.G_Button.big.max') : null;

          if (btn) {
            clearInterval(interval);

            const isBlocked = btn.classList.contains('block');

            if (isBlocked) {
              const timeDiv = btn.querySelector('.button_text');
              const timeText = timeDiv ? timeDiv.textContent.trim() : 'Brak czasu';
              resolve({ found: true, blocked: true, time: timeText });
            } else {
              resolve({ found: true, blocked: false });
            }
            return;
          }

          waited += step;
          if (waited >= maxWait) {
            clearInterval(interval);
            resolve({ found: false });
          }
        }, step);
      });
    });

    if (!caseInfo.found) {
      await ctx.reply('⚠️ Nie znaleziono przycisku daily case');
      logger.warn(`⚠️ [${userId}] Przycisk nie znaleziony`);
      return null;
    }

    if (caseInfo.blocked) {
      const timeParts = caseInfo.time.split(':');
      let timeFormatted = caseInfo.time;

      if (timeParts.length === 3) {
        const [godz, min, sek] = timeParts;
        timeFormatted = `${godz}h ${min}m ${sek}s`;
      }

      await ctx.reply(`⏰ Daily case dostępny za: ${timeFormatted}`);
      logger.info(`⏰ [${userId}] Daily case zablokowany: ${timeFormatted}`);
      return { blocked: true, time: caseInfo.time, timeFormatted };
    }

    await ctx.reply('✅ Daily case jest dostępny!');
    logger.info(`✅ [${userId}] Daily case dostępny`);
    return { blocked: false };

  } catch (error) {
    logger.error(`❌ [${userId}] Błąd sprawdzania:`, error.message);
    await ctx.reply(`❌ Błąd: ${error.message}`);
    return null;
  }
}

async function openDailyCase(ctx) {
  const userId = ctx.from.id.toString();
  let session = activeSessions.get(userId);

  const user = await loadUser(userId);
  const hasSteamCredentials = user && user.steamUsername && user.steamPassword;

  if (!session || !session.isLoggedIn || (session && !session.browser?.isConnected())) {
    if (hasSteamCredentials) {
      await ctx.reply('🔄 Nie jesteś zalogowany - automatyczne logowanie...');
      logger.info(`🔄 [${userId}] Automatyczne logowanie dla /open`);
      const loginSuccess = await loginToSteam(ctx, 'password');
      if (!loginSuccess) {
        return false;
      }
      session = activeSessions.get(userId);
    } else {
      await ctx.reply('❌ Nie jesteś zalogowany! Użyj /login lub najpierw zapisz dane Steam komendą /setsteam');
      return false;
    }
  }

  if (!session || !session.page || !session.browser) {
    logger.error(`❌ [${userId}] Sesja nie ma wymaganych właściwości (page/browser)`);
    await ctx.reply('❌ Błąd sesji! Spróbuj zalogować się ponownie /login');
    activeSessions.delete(userId);
    return false;
  }

  const { page, browser } = session;

  if (!browser.isConnected()) {
    await ctx.reply('❌ Przeglądarka została zamknięta! Zaloguj się ponownie /login');
    activeSessions.delete(userId);
    return false;
  }

  try {
    await page.goto('https://g4skins.com/daily-case/open', { waitUntil: 'networkidle2' });
    logger.info(`📦 [${userId}] Przygotowuję do otwarcia daily case...`);

    await ctx.reply('📦 Sprawdzam ekwipunek przed otwarciem...');

    const inventoryBefore = await page.evaluate(async (apiUrl) => {
      const response = await fetch(apiUrl, {
        method: 'GET',
        credentials: 'include'
      });
      if (!response.ok) return [];
      const data = await response.json();
      return (data.result || []).map(item => ({
        name: item.name,
        value: item.value
      }));
    }, CONFIG.URLS.G4SKINS_API_INVENTORY);

    logger.info(`📦 [${userId}] Ekwipunek przed: ${inventoryBefore.length} itemów`);

    const result = await page.evaluate(() => {
      return new Promise((resolve) => {
        let waited = 0;
        const maxWait = 2000;
        const step = 100;

        const interval = setInterval(() => {
          const container = document.querySelector('.top-options');
          const btn = container ? container.querySelector('.G_Button.big.max') : null;

          if (btn) {
            clearInterval(interval);

            if (btn.classList.contains('block')) {
              const timeDiv = btn.querySelector('.button_text');
              const timeText = timeDiv ? timeDiv.textContent.trim() : 'Brak czasu';
              resolve({ success: false, blocked: true, time: timeText });
              return;
            }

            btn.click();
            resolve({ success: true, clicked: true });
            return;
          }

          waited += step;
          if (waited >= maxWait) {
            clearInterval(interval);
            resolve({ success: false, notFound: true });
          }
        }, step);
      });
    });

    if (result.notFound) {
      await ctx.reply('❌ Nie znaleziono przycisku daily case');
      return false;
    }

    if (result.blocked) {
      const timeParts = result.time.split(':');
      let timeFormatted = result.time;
      if (timeParts.length === 3) {
        const [godz, min, sek] = timeParts;
        timeFormatted = `${godz}h ${min}m ${sek}s`;
      }
      await ctx.reply(`❌ Daily case zablokowany! Dostępny za: ${timeFormatted}`);
      return false;
    }

    await ctx.reply('🎁 Otwieranie daily case...');
    logger.info(`🎁 [${userId}] Otwarto daily case, czekam 3 sekundy...`);

    await new Promise(resolve => setTimeout(resolve, 3000));

    const inventoryAfter = await page.evaluate(async (apiUrl) => {
      const response = await fetch(apiUrl, {
        method: 'GET',
        credentials: 'include'
      });
      if (!response.ok) return [];
      const data = await response.json();
      return (data.result || []).map(item => ({
        name: item.name,
        value: item.value
      }));
    }, CONFIG.URLS.G4SKINS_API_INVENTORY);

    logger.info(`📦 [${userId}] Ekwipunek po: ${inventoryAfter.length} itemów`);

        // Kopiujemy stary ekwipunek, aby odznaczać z niego sztuki
        let tempBefore = [...inventoryBefore];
        let newItems = [];

        // Niezawodne wyszukiwanie nowych przedmiotów (rozwiązuje problem gdy wydropisz duplikat)
        for (const item of inventoryAfter) {
          const foundIndex = tempBefore.findIndex(b => b.name === item.name);
          if (foundIndex !== -1) {
            // Był już, usuwamy JEDNĄ sztukę z tymczasowej listy
            tempBefore.splice(foundIndex, 1);
          } else {
            // Nie było go (lub to kolejna nowa sztuka), więc to jest nasz nowy drop!
            newItems.push(item);
          }
        }

        // Wysyłanie odpowiedniego powiadomienia
        if (newItems.length === 0) {
          await bot.telegram.sendMessage(userId, '🎲 Dostałeś prawdopodobnie skrzynię lub EXP (sprawdź historię)');
          logger.info(`🎲 [${userId}] Brak nowych itemów (wpadł EXP lub skrzynka)`);
        } else {
          const skinsWithValue = newItems.map(item =>
            `${item.name} (${(item.value * 4).toFixed(2)} zł)`
          ).join('\n');

          await bot.telegram.sendMessage(userId, `🎁 Dostałeś:\n\n${skinsWithValue}`);
          logger.info(`✨ [${userId}] Nowe itemy: ${newItems.length} (${newItems.map(i => i.name).join(', ')})`);
        }

        return true;
  } catch (error) {
    logger.error(`❌ [${userId}] Błąd otwierania:`, error.message);
    await ctx.reply(`❌ Błąd: ${error.message}`);
    return false;
  } finally {
    if (ctx?.isSilent) {
      const currentSession = activeSessions.get(userId);
      if (currentSession && currentSession.browser && currentSession.browser.isConnected()) {
        try {
          await currentSession.browser.close();
          currentSession.browser = null;
          currentSession.page = null;
          setSessionAndTrack(userId, currentSession);
          logger.info(`🧹 [${userId}] Przeglądarka zamknięta po openDailyCase (cleanup)`);
        } catch (e) {
          logger.warn(`⚠️ [${userId}] Błąd zamykania przeglądarki w finally:`, e.message);
        }
      }
    }
  }
}

// ====== AUTOOPEN (SMART SCHEDULER & DB PERSISTENCE) ======

const autoOpenNotificationTracker = new Map();

async function startAutoOpen(ctx, bufferSeconds = 10, initialDelay = 0) {
  const userId = ctx.from.id.toString();
  const session = activeSessions.get(userId);

  if (!session || !session.isLoggedIn) {
    await ctx.reply('❌ Nie jesteś zalogowany! Użyj /login');
    return;
  }

  if (session.autoOpenTimeout && initialDelay === 0) {
    await ctx.reply('⚠️ AutoOpen już działa!');
    return;
  }

  if (initialDelay === 0) {
    await ctx.reply('🔄 AutoOpen uruchomiony (smart scheduler)');
    logger.info(`▶️ [${userId}] AutoOpen uruchomiony (smart scheduler)`);
  }

  function parseTimeToMs(timeStr) {
    const parts = timeStr.split(':').map(Number);
    if (parts.length === 3) {
      const [h, m, s] = parts;
      return (h * 3600 + m * 60 + s) * 1000;
    }
    return 5 * 60 * 1000;
  }

  async function ensureBrowserOpen() {
    try {
      const currentSession = activeSessions.get(userId);
      if (!currentSession) return false;

      if (!currentSession.browser || !currentSession.page) {
        const config = await getPuppeteerConfig();
        const newBrowser = isProduction ? await puppeteerCore.launch(config) : await puppeteer.launch({
          headless: false,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
          ]
        });
        const newPage = await newBrowser.newPage();
        await newPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await newPage.setViewport({ width: 1366, height: 768 });

        const savedCookies = await loadSessionCookies(userId);
        if (savedCookies && Array.isArray(savedCookies)) {
          const cleanedCookies = savedCookies.map(({ partitionKey, ...rest }) => rest);
          await newPage.setCookie(...cleanedCookies);
        }

        await newPage.goto('https://g4skins.com/daily-case/open', { waitUntil: 'networkidle2' });

        const isStillLoggedIn = await newPage.evaluate(() => {
          return !document.querySelector('.login-form-content');
        });

        if (isStillLoggedIn) {
          logger.info(`🔄 [${userId}] Przeglądarka przywrócona z cookies`);
          currentSession.browser = newBrowser;
          currentSession.page = newPage;
          setSessionAndTrack(userId, currentSession);
          return true;
        } else {
          await newBrowser.close();
          logger.error(`❌ [${userId}] Cookies wygasły`);
          return false;
        }
      }

      if (currentSession.browser.isConnected && !currentSession.browser.isConnected()) {
        await currentSession.browser.close();
        currentSession.browser = null;
        currentSession.page = null;
        setSessionAndTrack(userId, currentSession);
        return false;
      }

      return true;
    } catch (e) {
      logger.error(`⚠️ [${userId}] Błąd otwierania przeglądarki:`, e.message);
      return false;
    }
  }

  async function checkAndSchedule() {
    const currentSession = activeSessions.get(userId);
    if (!currentSession || !currentSession.isLoggedIn) return;

    if (autoOpenLocks.get(userId)) {
      logger.warn(`⚠️ [${userId}] AutoOpen już w trakcie wykonywania, pomijam duplikat`);
      return;
    }

    autoOpenLocks.set(userId, true);

    try {
      const opened = await ensureBrowserOpen();
      if (!opened) {
        scheduleNext(5 * 60 * 1000);
        return;
      }

      const silentCtx = {
        from: { id: userId },
        isSilent: true,
        reply: async (text) => {
          logger.info(`[${userId}] AutoOpen: ${text}`);
        }
      };

      const result = await checkDailyCase(silentCtx);

      if (!result) {
        scheduleNext(5 * 60 * 1000);
        return;
      }

      if (!result.blocked) {
        await bot.telegram.sendMessage(userId, '🎁 Otwieram daily case!');
        await openDailyCase(silentCtx);

        const delay = 20 * 60 * 60 * 1000 + bufferSeconds * 1000;
        await User.findOneAndUpdate({ telegramId: userId }, { autoOpenEnabled: true, nextCaseTime: Date.now() + delay }).catch(() => {});
        scheduleNext(delay);
      } else {
        const delay = parseTimeToMs(result.time) + bufferSeconds * 1000;
        const minutesLeft = Math.ceil(delay / 60000);
        logger.info(`[${userId}] AutoOpen: case za ${result.timeFormatted}, sprawdzam za ~${minutesLeft} min`);
        await bot.telegram.sendMessage(
          userId,
          `⏳ Daily case dostępny za ${result.timeFormatted}\n🔔 Otworzę automatycznie za ~${minutesLeft} min`
        );
        await closeBrowserSilently(userId);

        await User.findOneAndUpdate({ telegramId: userId }, { autoOpenEnabled: true, nextCaseTime: Date.now() + delay }).catch(() => {});
        scheduleNext(delay);
      }
    } finally {
      autoOpenLocks.delete(userId);
    }
  }

  function scheduleNext(delay) {
    const currentSession = activeSessions.get(userId);
    if (!currentSession) return;
    const timeout = setTimeout(checkAndSchedule, delay);
    currentSession.autoOpenTimeout = timeout;
    setSessionAndTrack(userId, currentSession);
  }

  async function closeBrowserSilently(userId) {
    const s = activeSessions.get(userId);
    if (s?.browser) {
      try {
        await s.browser.close();
        logger.info(`🧹 [${userId}] Przeglądarka zamknięta (silent cleanup)`);
      } catch (e) {
        logger.warn(`⚠️ [${userId}] Błąd zamykania przeglądarki:`, e.message);
      } finally {
        s.browser = null;
        s.page = null;
        setSessionAndTrack(userId, s);
      }
    }
  }

  if (initialDelay > 0) {
    scheduleNext(initialDelay);
  } else {
    await checkAndSchedule();
  }
}

function stopAutoOpen(ctx) {
  const userId = ctx.from.id.toString();
  const session = activeSessions.get(userId);

  if (!session || !session.autoOpenTimeout) {
    ctx.reply('⚠️ AutoOpen nie jest włączony');
    return;
  }

  clearTimeout(session.autoOpenTimeout);
  session.autoOpenTimeout = null;
  setSessionAndTrack(userId, session);

  autoOpenNotificationTracker.delete(userId);

  User.findOneAndUpdate({ telegramId: userId }, { autoOpenEnabled: false, nextCaseTime: null }).catch(() => {});

  logger.info(`⏹️ [${userId}] AutoOpen zatrzymany ręcznie`);
  ctx.reply('⏹️ AutoOpen zatrzymany');
}

const commands = [
  { command: '/start', description: 'Wszystkie komendy' },
  { command: '/login', description: 'Wybierz metodę logowania' },
  { command: '/autoopen', description: 'Włącz AutoOpen' },
  { command: '/close', description: 'Zamknij przeglądarkę' },
];

bot.command('start', (ctx) => {
  ctx.reply(
    '🤖 G4Skins Daily Case Bot\n\n' +
    '📋 Komendy:\n' +
    '/setsteam - Zapisz dane Steam (login/hasło)\n' +
    '/setpin - Zapisz PIN Family View (opcjonalnie)\n' +
    '/login - Wybierz metodę logowania\n' +
    '/check - Sprawdź status daily case\n' +
    '/open - Otwórz daily case\n' +
    '/autoopen - Włącz AutoOpen\n' +
    '/checkstatus - Status AutoOpen\n' +
    '/stop - Zatrzymaj AutoOpen\n' +
    '/logout - Wyloguj się\n' +
    '/resetall - ZAMKNIJ WSZYSTKIE SESJE (admin)\n' +
    '/close - Zamknij przeglądarkę\n' +
    '/dbtest - Sprawdź status bazy danych\n' +
    '/status - Sprawdź status sesji\n\n' +
    '💡 AutoOpen:\n' +
    '• Odlicza precyzyjny czas do skrzynki\n' +
    '• Zamyka przeglądarkę w tle (oszczędza RAM)\n' +
    '• Automatycznie otwiera case i wznawia odliczanie\n' +
    '• Pamięta harmonogram po restarcie serwera'
  );
});

bot.command('dbtest', async (ctx) => {
  const userId = ctx.from.id.toString();

  const dbStatus = mongoose.connection.readyState;
  const dbStatusText = {
    0: '❌ Rozłączony',
    1: '✅ Połączony',
    2: '🔄 Łączę...',
    3: '❌ Rozłączam...'
  }[dbStatus] || '❓ Nieznany';

  let userInfo = 'Nie znaleziono';
  try {
    const user = await User.findOne({ telegramId: userId });
    if (user) {
      userInfo = `
📝 Username: ${user.steamUsername || 'BRAK'}
🔐 Password: ${user.steamPassword ? '***' : 'BRAK'}
🔢 PIN: ${user.familyViewPin || 'BRAK'}
🔄 AutoOpen w bazie: ${user.autoOpenEnabled ? 'Tak' : 'Nie'}
      `.trim();
    }
  } catch (e) {
    userInfo = `Błąd: ${e.message}`;
  }

  ctx.reply(`
🗄️ **Status MongoDB**: ${dbStatusText}
👤 **Twój ID**: ${userId}
${userInfo}
  `.trim(), { parse_mode: 'Markdown' });
});

bot.command('checkstatus', (ctx) => {
  const userId = ctx.from.id.toString();
  const session = activeSessions.get(userId);
  const tracker = autoOpenNotificationTracker.get(userId);

  if (!session) {
    ctx.reply('❌ Nie jesteś zalogowany');
    return;
  }

  if (!session.autoOpenTimeout) {
    ctx.reply('⚠️ AutoOpen nie jest włączony\n\nUżyj /autoopen aby uruchomić');
    return;
  }

  let statusText = '✅ AutoOpen aktywny (smart scheduler)\n\n';
  statusText += '⏱️ Sprawdzanie: inteligentne (tylko gdy potrzebne)\n';
  statusText += '🎁 Auto otwieranie: włączone\n';
  statusText += '🔄 Kontynuacja: tak\n';

  if (tracker && tracker.lastBlockTime) {
    statusText += `\n⏰ Ostatni czas blokady: ${tracker.lastBlockTime}\n`;
    const timeSinceNotif = Math.floor((Date.now() - tracker.lastNotificationTime) / (60 * 1000));
    statusText += `💬 Ostatnie powiadomienie: ${timeSinceNotif} min temu`;
  }

  statusText += '\n\nUżyj /stop aby zatrzymać';

  ctx.reply(statusText);
});

bot.command('setpin', (ctx) => {
  ctx.reply(
    '🔐 Wyślij swój PIN Family View w formacie:\n\n' +
    '<code>PIN:1234</code>\n\n' +
    'Przykład: <code>PIN:5678</code>\n\n' +
    '⚠️ PIN musi mieć 4 cyfry',
    { parse_mode: 'HTML' }
  );
});

bot.hears(/^PIN:(\d{4})$/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const match = ctx.message.text.match(/^PIN:(\d{4})$/);
  const pin = match[1];

  const user = await loadUser(userId) || { telegramId: userId };
  user.familyViewPin = pin;
  await saveUser(user);

  ctx.deleteMessage();
  logger.info(`🔐 [${userId}] Family View PIN zapisany: ${pin}`);
  ctx.reply('✅ PIN Family View zapisany bezpiecznie!');
});

bot.hears(/^([^:]+):(.+)$/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const match = ctx.message.text.match(/^([^:]+):(.+)$/);
  const username = match[1].trim();
  const password = match[2].trim();

  if (username.toUpperCase() === 'PIN') {
    return;
  }

  if (username.length < 3) {
    ctx.reply('❌ Nazwa użytkownika Steam musi mieć co najmniej 3 znaki.');
    return;
  }

  if (password.length < 6) {
    ctx.reply('❌ Hasło Steam musi mieć co najmniej 6 znaków.');
    return;
  }

  const user = await loadUser(userId) || { telegramId: userId };
  user.steamUsername = username;
  user.steamPassword = password;
  await saveUser(user);

  ctx.deleteMessage();
  logger.info(`🔐 [${userId}] Dane Steam zapisane`);
  ctx.reply('✅ Dane Steam zapisane bezpiecznie!');
});

bot.command('login', (ctx) => {
  ctx.reply(
    '🔐 Wybierz metodę logowania:',
    Markup.inlineKeyboard([
      [Markup.button.callback('🔑 Login i hasło', 'login_password')],
      [Markup.button.callback('📱 QR Code', 'login_qr')]
    ])
  );
});

bot.action('login_password', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (e) {
    logger.warn(`⚠️ Nie można odpowiedzieć na callback query: ${e.message}`);
    return;
  }
  try {
    await ctx.editMessageText('🔄 Logowanie przez login i hasło...');
  } catch (e) {
    logger.warn(`⚠️ Nie można edytować wiadomości: ${e.message}`);
  }
  await loginToSteam(ctx, 'password');
});

bot.action('login_qr', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (e) {
    logger.warn(`⚠️ Nie można odpowiedzieć na callback query: ${e.message}`);
    return;
  }
  try {
    await ctx.editMessageText('🔄 Logowanie przez QR code...');
  } catch (e) {
    logger.warn(`⚠️ Nie można edytować wiadomości: ${e.message}`);
  }
  await loginToSteam(ctx, 'qr');
});

bot.command('check', checkDailyCase);
bot.command('open', openDailyCase);

bot.command('autoopen', (ctx) => {
  startAutoOpen(ctx, 5);
});

bot.command('stop', stopAutoOpen);

bot.command('close', async (ctx) => {
  const userId = ctx.from.id.toString();
  const session = activeSessions.get(userId);

  if (session) {
    if (session.autoOpenTimeout) {
      clearTimeout(session.autoOpenTimeout);
      logger.info(`⏹️ [${userId}] AutoOpen zatrzymany przy close`);
    }

    if (session.browser) {
      try {
        await session.browser.close();
        logger.info(`🚪 [${userId}] Przeglądarka zamknięta (bez usunięcia cookies)`);
      } catch (e) {
        logger.error(`⚠️ [${userId}] Błąd zamykania przeglądarki:`, e.message);
      }
    }

    activeSessions.delete(userId);

    ctx.reply('🚪 Okienko przeglądarki zostało zamknięte. Sesja cookies została zachowana.');
  } else {
    ctx.reply('⚠️ Nie masz otwartej sesji przeglądarki');
  }
});

bot.command('logout', async (ctx) => {
  const userId = ctx.from.id.toString();
  const session = activeSessions.get(userId);

  if (session) {
    if (session.autoOpenTimeout) {
      clearTimeout(session.autoOpenTimeout);
      logger.info(`⏹️ [${userId}] AutoOpen zatrzymany przy logout`);
    }

    if (session.browser) {
      try {
        await session.browser.close();
        logger.info(`🚪 [${userId}] Przeglądarka zamknięta`);
      } catch (e) {
        logger.error(`⚠️ [${userId}] Błąd zamykania przeglądarki:`, e.message);
      }
    }

    activeSessions.delete(userId);

    await Session.deleteOne({ telegramId: userId });
    await User.findOneAndUpdate({ telegramId: userId }, { autoOpenEnabled: false, nextCaseTime: null }).catch(() => {});

    ctx.reply('👋 Wylogowano i zamknięto sesję');
  } else {
    ctx.reply('⚠️ Nie jesteś zalogowany');
  }
});

bot.command('resetall', async (ctx) => {
  logger.info('🔄 [RESETALL] Rozpoczynam reset wszystkich sesji...');

  let closedCount = 0;
  for (const [userId, session] of activeSessions.entries()) {
    try {
      if (session.autoOpenTimeout) {
        clearTimeout(session.autoOpenTimeout);
        logger.info(`⏹️ [${userId}] AutoOpen zatrzymany przy reset`);
      }

      if (session.browser) {
        await session.browser.close();
        logger.info(`🚪 [${userId}] Przeglądarka zamknięta przy reset`);
      }

      closedCount++;
    } catch (e) {
      logger.error(`⚠️ [${userId}] Błąd zamykania przeglądarki przy reset:`, e.message);
    }
  }

  activeSessions.clear();

  try {
    await Session.deleteMany({});
    await User.updateMany({}, { autoOpenEnabled: false, nextCaseTime: null });
    logger.info('🗑️ Wszystkie zapisane sesje usunięte z bazy danych');
  } catch (e) {
    logger.error('⚠️ Błąd usuwania sesji z bazy:', e.message);
  }

  await ctx.reply(`🔄 Reset zakończony!\nZamknięto ${closedCount} aktywnych sesji.\nWszystkie dane wyczyszczone.\nBot gotowy do nowego startu.`);
  logger.info(`✅ [RESETALL] Reset zakończony - zamknięto ${closedCount} sesji`);
});

bot.command('status', (ctx) => {
  const userId = ctx.from.id.toString();
  const session = activeSessions.get(userId);

  if (!session) {
    ctx.reply('❌ Nie jesteś zalogowany');
    return;
  }

  const browserStatus = session.browser && session.browser.isConnected() ? '✅ Aktywna' : '❌ Zamknięta';

  const status =
    `📊 Status sesji:\n\n` +
    `✅ Zalogowany: ${session.isLoggedIn ? 'Tak' : 'Nie'}\n` +
    `🔐 Metoda: ${session.loginMethod || 'Brak'}\n` +
    `🌐 Przeglądarka: ${browserStatus}\n` +
    `🔄 AutoOpen: ${session.autoOpenTimeout ? 'Włączony' : 'Wyłączony'}`;

  ctx.reply(status);
});

// ====== PRZYWRACANIE AUTOOPEN PO RESTARCIE SERWERA ======
async function restoreAutoOpenTasks() {
  try {
    const users = await User.find({ autoOpenEnabled: true });
    if (users.length === 0) return;

    logger.info(`🔄 Przywracanie AutoOpen dla ${users.length} użytkowników...`);

    for (const user of users) {
      const userId = user.telegramId;
      const now = Date.now();

      let delay = user.nextCaseTime ? (user.nextCaseTime - now) : 10000;
      if (delay < 0) {
        delay = 10000 + Math.floor(Math.random() * 20000);
      }

      activeSessions.set(userId, { isLoggedIn: true });

      const mockCtx = {
        from: { id: parseInt(userId) },
        isSilent: true,
        reply: async (text) => {
          try {
            await bot.telegram.sendMessage(userId, text);
          } catch(e) {
            logger.warn(`⚠️ Nie można wysłać wiadomości przywracania do ${userId}`);
          }
        }
      };

      logger.info(`⏰ [${userId}] AutoOpen przywrócony - sprawdzenie nastąpi za ~${Math.round(delay / 60000)} min`);

      startAutoOpen(mockCtx, 10, delay);
    }
  } catch (e) {
    logger.error('❌ Błąd podczas przywracania AutoOpen z bazy danych:', e.message);
  }
}

// URUCHOMIENIE - NAJPIERW MONGODB, POTEM BOT
async function startBot() {
  logger.info('🚀 Uruchamiam bota...');

  logger.info('📦 Łączę z MongoDB...');
  const dbConnected = await connectDB();

  if (!dbConnected) {
    logger.error('❌ Nie można połączyć z MongoDB - kończę!');
    process.exit(1);
  }

  await bot.telegram.setMyCommands(commands);
  await bot.telegram.setChatMenuButton({
    menu_button: {
      type: 'commands',
      text: 'Menu'
    }
  });

  logger.info('🤖 MongoDB połączony - uruchamiam bota Telegram...');

  try {
    await bot.launch();
    logger.info('✅ Bot uruchomiony pomyślnie!');
    logger.info('🎯 Bot gotowy do pracy - wyślij /start w Telegramie');

    // Przywróć zadania AutoOpen zapisane w bazie
    await restoreAutoOpenTasks();

    if (!isProduction) {
      const ConsoleCommands = require('./console-commands');
      const consoleCmd = new ConsoleCommands(
        bot,
        activeSessions,
        loadUser,
        loginToSteam,
        checkDailyCase,
        openDailyCase
      );

      setTimeout(() => {
        consoleCmd.start();
      }, 500);
    }
  } catch (err) {
    logger.error('❌ Błąd uruchamiania bota:', err);
    process.exit(1);
  }
}

startBot();

// Graceful shutdown
process.once('SIGINT', async () => {
  logger.info('🛑 Otrzymano SIGINT, zamykam bota...');
  for (const [userId, session] of activeSessions) {
    if (session.autoOpenTimeout) clearTimeout(session.autoOpenTimeout);
    if (session.browser) {
      try {
        await session.browser.close();
      } catch (e) {
        logger.error(`Błąd zamykania przeglądarki [${userId}]:`, e.message);
      }
    }
  }
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', async () => {
  logger.info('🛑 Otrzymano SIGTERM, zamykam bota...');
  for (const [userId, session] of activeSessions) {
    if (session.autoOpenTimeout) clearTimeout(session.autoOpenTimeout);
    if (session.browser) {
      try {
        await session.browser.close();
      } catch (e) {
        logger.error(`Błąd zamykania przeglądarki [${userId}]:`, e.message);
      }
    }
  }
  bot.stop('SIGTERM');
  process.exit(0);
});
