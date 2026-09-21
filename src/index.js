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
const logger = require('./logger');

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

// Struktura: { telegramId: { browser, page, username, loginMethod, isLoggedIn, autoOpenTimeout, autoOpenEnabled, nextCaseTime } }
const activeSessions = new Map();
const sessionCreationTime = new Map();
const autoOpenLocks = new Map();

// Śledzenie ostatnich logów watchdog (żeby logować co ~10 min w tle)
const lastWatchdogLogTime = new Map();

// ====== AUTO-CLEANUP STARYCH SESJI (oszczędzanie RAM) ======
async function cleanupIdleSessions() {
  const now = Date.now();
  const sessionsToDelete = [];

  for (const [userId, session] of activeSessions.entries()) {
    const createdTime = sessionCreationTime.get(userId) || 0;
    const idleTime = now - createdTime;

    // Sprawdź czy użytkownik ma włączony AutoOpen
    const isAutoOpen = session?.autoOpenEnabled || session?.autoOpenTimeout;

    if (isAutoOpen) {
      // Jeśli sesja ma aktywny AutoOpen, ale przeglądarka 'wisi' bezczynna – zamknij ją dla RAM
      if (session.browser && idleTime > CONFIG.SESSION_IDLE_TIMEOUT) {
        logger.info(`🧹 [${userId}] Zamykam bezczynną przeglądarkę oczekującą na AutoOpen (oszczędzanie RAM)`);
        try {
          await session.browser.close();
        } catch (e) {}
        session.browser = null;
        session.page = null;
      }
      continue; // Nie usuwaj wpisu sesji dla AutoOpen!
    }

    if (idleTime > CONFIG.SESSION_IDLE_TIMEOUT) {
      logger.info(`🧹 [${userId}] Czyszczę idle session (${Math.round(idleTime / 60000)} min nieaktywna)`);
      sessionsToDelete.push(userId);
    }
  }

  // Zamknij i usuń nieużywane sesje
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
    lastWatchdogLogTime.delete(userId);
  }

  if (activeSessions.size > 0) {
    logger.info(`💾 RAM: ${activeSessions.size} zarejestrowanych sesji w pamięci`);
  }
}

setInterval(cleanupIdleSessions, CONFIG.CLEANUP_INTERVAL);

function setSessionAndTrack(userId, session) {
  if (session?.browser && session?.page) {
    sessionCreationTime.set(userId, Date.now());
  }
  activeSessions.set(userId, session);
}

// ====== FUNKCJE POMOCNICZE CZASU I BAZY ======

/**
 * Precyzyjne parsowanie stringa czasu do milisekund
 * Obsługuje formaty:
 * - "19 h  42 m  06s", "19h 42m 06s", "42m 06s", "45s"
 * - "19:42:06", "05:30", "15"
 * - "19 godz 42 min 06 sek"
 */
function parseTimeToMs(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 5 * 60 * 1000;

  const clean = timeStr.trim().toLowerCase();

  const hMatch = clean.match(/(\d+)\s*(?:h|godz)/);
  const mMatch = clean.match(/(\d+)\s*(?:m|min)/);
  const sMatch = clean.match(/(\d+)\s*(?:s|sek)/);

  if (hMatch || mMatch || sMatch) {
    const h = hMatch ? parseInt(hMatch[1], 10) : 0;
    const m = mMatch ? parseInt(mMatch[1], 10) : 0;
    const s = sMatch ? parseInt(sMatch[1], 10) : 0;
    const totalMs = (h * 3600 + m * 60 + s) * 1000;
    if (totalMs > 0) return totalMs;
  }

  const colonParts = clean.split(':').map(p => parseInt(p.trim(), 10)).filter(n => !isNaN(n));
  if (colonParts.length === 3) {
    return (colonParts[0] * 3600 + colonParts[1] * 60 + colonParts[2]) * 1000;
  } else if (colonParts.length === 2) {
    return (colonParts[0] * 60 + colonParts[1]) * 1000;
  } else if (colonParts.length === 1 && colonParts[0] > 0) {
    return colonParts[0] * 1000;
  }

  return 5 * 60 * 1000; // Fallback: 5 min
}

/**
 * Formatuje ms do czytelnego ciągu np. "19h 42m 06s"
 */
function formatTimeMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0) parts.push(`${m}m`);
  parts.push(`${s.toString().padStart(2, '0')}s`);
  return parts.join(' ');
}

async function loadUser(userId) {
  try {
    if (mongoose.connection.readyState !== 1) {
      logger.warn('MongoDB nie jest połączony podczas loadUser');
      return null;
    }

    const user = await User.findOne({ telegramId: userId });
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
    logger.info(`💾 [${userId}] Cookies zapisane w bazie`);
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

// ====== STEAM LOGIN FLOW ======

async function loginToSteam(ctx, loginMethod = 'password') {
  const userId = ctx.from.id.toString();
  let session = activeSessions.get(userId);

  try {
    if (!session || !session.browser || !session.browser.isConnected()) {
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

      // Monitoruj crash / zamknięcie przeglądarki BEZ resetowania isLoggedIn
      browser.on('disconnected', () => {
        logger.warn(`⚠️ [${userId}] Przeglądarka odłączona (zamknięcie/crash)`);
        const currentSession = activeSessions.get(userId);
        if (currentSession) {
          currentSession.browser = null;
          currentSession.page = null;
          setSessionAndTrack(userId, currentSession);
        }
      });

      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1366, height: 768 });

      const savedCookies = await loadSessionCookies(userId);
      if (savedCookies && Array.isArray(savedCookies) && savedCookies.length > 0) {
        const cleanedCookies = savedCookies.map(({ partitionKey, ...rest }) => rest);
        await page.setCookie(...cleanedCookies);
        await page.goto(CONFIG.URLS.G4SKINS_DAILY, { waitUntil: 'networkidle2' }).catch(() => {});

        const stillLoggedIn = await page.evaluate(() => {
          return !document.querySelector('.login-form-content');
        }).catch(() => false);

        if (stillLoggedIn) {
          logger.info(`✅ [${userId}] Zalogowano automatycznie z cookies`);
          ctx.reply(`Zalogowano automatycznie z cookies`);
          session = session || {};
          session.browser = browser;
          session.page = page;
          session.isLoggedIn = true;
          session.loginMethod = loginMethod;
          setSessionAndTrack(userId, session);
          return true;
        }
      }

      session = session || {};
      session.browser = browser;
      session.page = page;
      session.isLoggedIn = false;
      session.loginMethod = loginMethod;
      setSessionAndTrack(userId, session);
    }

    const { page } = session;

    if (!ctx.isSilent) await ctx.reply('🔄 Rozpoczynam logowanie...');
    await page.goto(CONFIG.URLS.G4SKINS_DAILY, { waitUntil: 'networkidle2' });

    try {
      await page.waitForSelector(SELECTORS.g4skins.loginForm, { timeout: 10000 });
    } catch (e) {
      const alreadyLoggedIn = await page.evaluate(() => {
        return !document.querySelector('.login-form-content');
      });

      if (alreadyLoggedIn) {
        if (!ctx.isSilent) await ctx.reply('✅ Już jesteś zalogowany!');
        session.isLoggedIn = true;
        setSessionAndTrack(userId, session);
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    if (!ctx.isSilent) await ctx.reply('☑️ Zaznaczam checkboxy...');

    await page.waitForSelector(SELECTORS.g4skins.checkbox, { timeout: 5000 }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 1500));

    const checkboxes = await page.$$(SELECTORS.g4skins.checkbox);
    let clickedCount = 0;

    for (let i = 0; i < checkboxes.length; i++) {
      try {
        await checkboxes[i].click();
        clickedCount++;
      } catch (err) {
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

    logger.info(`[${userId}] Checkboxy kliknięte: ${clickedCount}/${checkboxes.length}`);
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (!ctx.isSilent) await ctx.reply('🎮 Przechodzę do Steam...');

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

    logger.info(`✅ [${userId}] Logowanie Steam zakończone pomyślnie`);
    return true;

  } catch (error) {
    logger.error(`❌ [${userId}] Błąd logowania:`, error.message);
    if (!ctx.isSilent) await ctx.reply(`❌ Błąd logowania: ${error.message}`);
    return false;
  }
}

async function handlePasswordLogin(ctx, page, userId) {
  const user = await loadUser(userId);

  if (!user || !user.steamUsername || !user.steamPassword) {
    if (!ctx.isSilent) await ctx.reply('❌ Nie masz zapisanych danych Steam! Użyj /setsteam');
    throw new Error('Brak danych Steam');
  }

  if (!ctx.isSilent) await ctx.reply('🔑 Wpisuję dane logowania...');

  const usernameSelector = await findElement(page, SELECTORS.steam.usernameInput);
  await page.click(usernameSelector);
  await page.keyboard.type(user.steamUsername);

  const passwordSelector = await findElement(page, SELECTORS.steam.passwordInput);
  await page.click(passwordSelector);
  await page.keyboard.type(user.steamPassword);

  const submitSelector = await findElement(page, SELECTORS.steam.submitButton);
  await page.click(submitSelector);

  await waitForRedirectOrGuard(ctx, page, userId);
}

async function handleQRLogin(ctx, page, userId) {
  if (!ctx.isSilent) await ctx.reply('📱 Tryb logowania QR - czekam na kod...');

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
            const target = mutation.target;
            if (target.tagName === 'IMG' && target.src && target.src.startsWith('blob:')) {
              window.onQRChange(target.src);
            }
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
    logger.warn(`⚠️ [${userId}] Sesja nie znaleziona przy QR`);
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
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          });
        } catch (e) {
          return null;
        }
      }, blobUrl);
      base64 = base64Result;
    } catch (e) {
      logger.warn(`⚠️ [${userId}] Metoda fetch QR nie zadziałała:`, e.message);
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
        logger.warn(`⚠️ [${userId}] Metoda canvas QR nie zadziałała:`, e.message);
      }
    }

    if (!base64) {
      logger.warn(`⚠️ [${userId}] Nie udało się skonwertować QR`);
      if (!ctx.isSilent) await ctx.reply('📱 Nie mogę wyświetlić QR kodu - zeskanuj kod w aplikacji Steam Mobile.');
      return;
    }

    const base64Data = base64.split(',')[1];
    if (!base64Data) throw new Error('Brak danych base64');

    const buffer = Buffer.from(base64Data, 'base64');
    await bot.telegram.sendPhoto(
      userId,
      { source: buffer },
      { caption: '📱 Zeskanuj ten kod w aplikacji Steam Mobile', parse_mode: 'HTML' }
    );

    logger.info(`✅ [${userId}] QR kod wysłany`);

  } catch (error) {
    logger.error(`❌ [${userId}] Błąd wysyłania QR:`, error.message);
  }
}

async function handleFamilyView(ctx, page, userId) {
  const user = await loadUser(userId);

  if (!user || !user.familyViewPin) {
    logger.warn(`[${userId}]: Brak zapisanego PIN-u Family View`);
    return false;
  }

  const pin = user.familyViewPin;
  logger.info(`[${userId}]: Użyję PIN ${pin.replace(/./g, '*')}`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    logger.info(`[${userId}]: Próba ${attempt}/3 obsługi Family View`);
    if (!ctx.isSilent) await ctx.reply(`🔄 Próba ${attempt}/3 - wpisuję PIN Family View...`);

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
        logger.info(`[${userId}]: Family View nie jest wymagany - kontynuuję`);
        return true;
      }

      await new Promise(resolve => setTimeout(resolve, 2000));

      let pinInput = null;
      try {
        pinInput = await page.$('._2YxW3WqLGy7hz_21m6KbGD[type="password"]');
      } catch (e) {}

      if (!pinInput) {
        pinInput = await page.$('input[type="password"]');
      }

      if (!pinInput) {
        throw new Error('Nie znaleziono pola PIN');
      }

      await pinInput.click();
      await new Promise(resolve => setTimeout(resolve, 300));

      await page.evaluate(() => {
        const input = document.querySelector('input[type="password"]');
        if (input) {
          input.value = '';
          input.focus();
        }
      });

      for (const digit of pin) {
        await page.keyboard.type(digit);
        await new Promise(resolve => setTimeout(resolve, 150));
      }

      let okButton = null;
      try {
        okButton = await page.$('button._2KPv6oWB6ZxjWuqyNp_edP.DialogButton') || await page.$('button[type="submit"]');
      } catch (e) {}

      if (!okButton) {
        okButton = await page.evaluateHandle(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          return buttons.find(btn => btn.textContent.trim() === 'OK');
        });
        if (okButton) okButton = okButton.asElement();
      }

      if (okButton) {
        await okButton.click();
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      const familyViewGone = await page.evaluate(() => {
        const allText = document.body.innerText || document.body.textContent;
        return !allText.includes('Family View') && !allText.includes('Enter your PIN');
      });

      if (familyViewGone) {
        logger.info(`✅ [${userId}]: Family View pomyślnie odblokowany!`);
        return true;
      }

      await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (error) {
      logger.error(`[${userId}]: Błąd Family View:`, error.message);
    }
  }

  return false;
}

async function waitForRedirectOrGuard(ctx, page, userId) {
  if (!ctx.isSilent) await ctx.reply('⏳ Czekam na zalogowanie (max 2 minuty)...');

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
        isLoginPage
      };
    });
    return familyViewDetection;
  };

  try {
    while (Date.now() - startTime < maxWaitTime) {
      const currentUrl = await page.evaluate(() => window.location.href);

      if (currentUrl.includes('steamcommunity.com') || currentUrl.includes('steampowered.com')) {
        const familyCheck = await checkForFamilyView();

        if (familyCheck.detected) {
          familyViewAttempts++;
          logger.info(`👨‍👩‍👧 [${userId}] Wykryto Family View (próba ${familyViewAttempts}/3)`);

          if (familyViewAttempts > 3) {
            if (!ctx.isSilent) await ctx.reply('❌ Logowanie przerwane - zbyt wiele prób Family View.');
            return false;
          }

          const handled = await handleFamilyView(ctx, page, userId);
          if (!handled) {
            if (!ctx.isSilent) await ctx.reply('❌ Nie udało się odblokować Family View. Sprawdź PIN (/setpin).');
            return false;
          }

          await new Promise(resolve => setTimeout(resolve, 3000));
          continue;
        }
      }

      if (currentUrl.includes('steamcommunity.com/openid/login')) {
        logger.info(`[${userId}]: Wykryto stronę potwierdzenia OpenID`);

        const familyCheckBeforeClick = await checkForFamilyView();
        if (familyCheckBeforeClick.detected) {
          await handleFamilyView(ctx, page, userId);
          await new Promise(resolve => setTimeout(resolve, 3000));
          continue;
        }

        const hasSignInButton = await page.evaluate(() => {
          return !!document.querySelector('input[type="submit"][id="imageLogin"], input[value="Sign In"], button[type="submit"]');
        });

        if (hasSignInButton) {
          logger.info(`[${userId}]: Znaleziono przycisk Sign In, klikam...`);
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

            await new Promise(resolve => setTimeout(resolve, 2000));

            const familyCheckAfterClick = await checkForFamilyView();
            if (familyCheckAfterClick.detected) {
              await handleFamilyView(ctx, page, userId);
              await new Promise(resolve => setTimeout(resolve, 3000));
            }
          } catch (e) {
            logger.error(`[${userId}]: Błąd klikania Sign In:`, e.message);
          }
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

        if (hasGuardInput && !ctx.isSilent) {
          logger.info(`🔐 [${userId}] Wykryto Steam Guard`);
          await ctx.reply('🔐 Wymagany kod Steam Guard!\n\nWpisz kod w przeglądarce.');
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

    logger.info(`⏳ [${userId}] Czekam na stronę g4skins...`);
    await page.waitForFunction(
      () => window.location.href.includes('g4skins.com'),
      { timeout: 30000 }
    );

  } catch (error) {
    logger.error(`⚠️ [${userId}] Timeout logowania:`, error.message);
    if (!ctx.isSilent) {
      await ctx.reply('⏰ Upłynął limit czasu oczekiwania na logowanie.');
    }
    return false;
  }

  try {
    await page.goto(CONFIG.URLS.G4SKINS_DAILY, { waitUntil: 'networkidle2', timeout: 15000 });

    const loggedIn = await page.evaluate(() => {
      return !document.querySelector('.login-form-content');
    });

    if (loggedIn) {
      const cookies = await page.cookies();
      await saveSessionCookies(userId, cookies);

      session.isLoggedIn = true;
      setSessionAndTrack(userId, session);

      logger.info(`✅ [${userId}] Zalogowano pomyślnie`);
      if (!ctx.isSilent) await ctx.reply('✅ Zalogowano pomyślnie! Sesja zapisana.');
      return true;
    } else {
      if (!ctx.isSilent) await ctx.reply('⚠️ Logowanie nie powiodło się. Spróbuj ponownie /login');
      return false;
    }
  } catch (error) {
    logger.error(`⚠️ [${userId}] Błąd weryfikacji logowania:`, error.message);
    return false;
  }
}

// ====== ZARZĄDZANIE SESJĄ PRZEGLĄDARKI (SILENT RUNNER) ======

/**
 * Upewnia się, że przeglądarka jest otwarta i zalogowana.
 * Odtwarza sesję z cookies lub loguje danymi Steam.
 */
async function ensureBrowserOpen(userId, ctx = null) {
  let session = activeSessions.get(userId);

  // 1. Jeśli sesja ma już otwartą i połączoną przeglądarkę
  if (session?.browser && session.browser.isConnected() && session?.page) {
    try {
      const currentUrl = session.page.url();
      if (!currentUrl.includes('g4skins.com')) {
        await session.page.goto(CONFIG.URLS.G4SKINS_DAILY, { waitUntil: 'networkidle2', timeout: 30000 });
      }
      return session;
    } catch (e) {
      logger.warn(`⚠️ [${userId}] Błąd nawigacji istniejącej strony: ${e.message}`);
    }
  }

  logger.info(`🌐 [${userId}] Otwieram przeglądarkę (przywracanie sesji)...`);
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
      if (attempt === maxRetries) return null;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1366, height: 768 });

  // Odpięcie przeglądarki bez czyszczenia statusu zalogowania w bazie
  browser.on('disconnected', () => {
    logger.warn(`⚠️ [${userId}] Przeglądarka odłączona (zamknięcie/crash)`);
    const s = activeSessions.get(userId);
    if (s) {
      s.browser = null;
      s.page = null;
      setSessionAndTrack(userId, s);
    }
  });

  // 2. Spróbuj przywrócić z zapisanych cookies
  const savedCookies = await loadSessionCookies(userId);
  if (savedCookies && Array.isArray(savedCookies) && savedCookies.length > 0) {
    const cleanedCookies = savedCookies.map(({ partitionKey, ...rest }) => rest);
    await page.setCookie(...cleanedCookies);
    await page.goto(CONFIG.URLS.G4SKINS_DAILY, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

    const isStillLoggedIn = await page.evaluate(() => {
      return !document.querySelector('.login-form-content');
    }).catch(() => false);

    if (isStillLoggedIn) {
      logger.info(`✅ [${userId}] Przeglądarka pomyślnie wznowiona z cookies`);
      session = session || {};
      session.browser = browser;
      session.page = page;
      session.isLoggedIn = true;
      setSessionAndTrack(userId, session);
      return session;
    } else {
      logger.warn(`⚠️ [${userId}] Cookies wygasły lub nie są już ważne`);
    }
  }

  // 3. Jeśli cookies nie zadziałały, spróbuj automatycznego logowania przez Steam
  const user = await loadUser(userId);
  if (user?.steamUsername && user?.steamPassword) {
    logger.info(`🔄 [${userId}] Próba automatycznego ponownego logowania Steam...`);
    session = session || {};
    session.browser = browser;
    session.page = page;
    setSessionAndTrack(userId, session);

    const loginCtx = ctx || {
      from: { id: parseInt(userId, 10) },
      isSilent: true,
      reply: async (text) => logger.info(`[${userId}] AutoLogin: ${text}`)
    };

    const loggedIn = await loginToSteam(loginCtx, 'password');
    if (loggedIn) {
      return activeSessions.get(userId);
    }
  }

  // Jeśli wszystko zawiodło, zamknij nowo otwartą przeglądarkę
  try {
    await browser.close();
  } catch (e) {}

  logger.error(`❌ [${userId}] Nie udało się otworzyć zalogowanej sesji`);
  return null;
}

/**
 * Ciche zamykanie przeglądarki w celu oszczędzania RAM,
 * zachowując dane harmonogramu AutoOpen.
 */
async function closeBrowserSilently(userId) {
  const session = activeSessions.get(userId);
  if (session?.browser) {
    try {
      await session.browser.close();
      logger.info(`🧹 [${userId}] Przeglądarka zamknięta w tle (oszczędzanie RAM)`);
    } catch (e) {
      logger.warn(`⚠️ [${userId}] Błąd cichego zamykania przeglądarki: ${e.message}`);
    } finally {
      session.browser = null;
      session.page = null;
      setSessionAndTrack(userId, session);
    }
  }
}

// ====== G4SKINS API & OPERATIONS ======

async function checkDailyCase(ctx) {
  const userId = ctx.from.id.toString();
  const sessionObj = await ensureBrowserOpen(userId, ctx);

  if (!sessionObj || !sessionObj.page || !sessionObj.browser?.isConnected()) {
    if (!ctx.isSilent) await ctx.reply('❌ Nie jesteś zalogowany! Użyj /login lub najpierw zapisz dane Steam komendą /setsteam');
    return null;
  }

  const { page } = sessionObj;

  try {
    await page.goto(CONFIG.URLS.G4SKINS_DAILY, { waitUntil: 'networkidle2', timeout: 30000 });
    logger.info(`🔍 [${userId}] Sprawdzam daily case...`);

    const caseInfo = await page.evaluate(() => {
      return new Promise((resolve) => {
        let waited = 0;
        const maxWait = 3000;
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
      if (!ctx.isSilent) await ctx.reply('⚠️ Nie znaleziono przycisku daily case');
      logger.warn(`⚠️ [${userId}] Przycisk daily case nie znaleziony`);
      return null;
    }

    if (caseInfo.blocked) {
      const timeMs = parseTimeToMs(caseInfo.time);
      const timeFormatted = formatTimeMs(timeMs);

      if (!ctx.isSilent) await ctx.reply(`⏰ Daily case dostępny za: ${timeFormatted}`);
      logger.info(`⏰ [${userId}] Daily case zablokowany: ${timeFormatted} (raw: "${caseInfo.time}")`);
      return { found: true, blocked: true, time: caseInfo.time, timeFormatted, timeMs };
    }

    if (!ctx.isSilent) await ctx.reply('✅ Daily case jest dostępny!');
    logger.info(`✅ [${userId}] Daily case dostępny do otwarcia`);
    return { found: true, blocked: false };

  } catch (error) {
    logger.error(`❌ [${userId}] Błąd sprawdzania daily case:`, error.message);
    if (!ctx.isSilent) await ctx.reply(`❌ Błąd: ${error.message}`);
    return null;
  }
}

async function openDailyCase(ctx) {
  const userId = ctx.from.id.toString();
  const sessionObj = await ensureBrowserOpen(userId, ctx);

  if (!sessionObj || !sessionObj.page || !sessionObj.browser?.isConnected()) {
    if (!ctx.isSilent) await ctx.reply('❌ Nie jesteś zalogowany! Użyj /login lub najpierw zapisz dane Steam komendą /setsteam');
    return false;
  }

  const { page } = sessionObj;

  try {
    await page.goto(CONFIG.URLS.G4SKINS_DAILY, { waitUntil: 'networkidle2', timeout: 30000 });
    logger.info(`📦 [${userId}] Przygotowuję do otwarcia daily case...`);

    if (!ctx.isSilent) await ctx.reply('📦 Sprawdzam ekwipunek przed otwarciem...');

    const inventoryBefore = await page.evaluate(async (apiUrl) => {
      try {
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
      } catch (e) {
        return [];
      }
    }, CONFIG.URLS.G4SKINS_API_INVENTORY);

    logger.info(`📦 [${userId}] Ekwipunek przed: ${inventoryBefore.length} itemów`);

    const result = await page.evaluate(() => {
      return new Promise((resolve) => {
        let waited = 0;
        const maxWait = 3000;
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
      if (!ctx.isSilent) await ctx.reply('❌ Nie znaleziono przycisku daily case');
      return false;
    }

    if (result.blocked) {
      const timeMs = parseTimeToMs(result.time);
      const timeFormatted = formatTimeMs(timeMs);
      if (!ctx.isSilent) await ctx.reply(`❌ Daily case zablokowany! Dostępny za: ${timeFormatted}`);
      return false;
    }

    if (!ctx.isSilent) await ctx.reply('🎁 Otwieranie daily case...');
    logger.info(`🎁 [${userId}] Otwarto daily case, czekam na zatwierdzenie dropu...`);

    await new Promise(resolve => setTimeout(resolve, 4000));

    const inventoryAfter = await page.evaluate(async (apiUrl) => {
      try {
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
      } catch (e) {
        return [];
      }
    }, CONFIG.URLS.G4SKINS_API_INVENTORY);

    logger.info(`📦 [${userId}] Ekwipunek po: ${inventoryAfter.length} itemów`);

    let tempBefore = [...inventoryBefore];
    let newItems = [];

    for (const item of inventoryAfter) {
      const foundIndex = tempBefore.findIndex(b => b.name === item.name);
      if (foundIndex !== -1) {
        tempBefore.splice(foundIndex, 1);
      } else {
        newItems.push(item);
      }
    }

    if (newItems.length === 0) {
      await bot.telegram.sendMessage(userId, '🎲 Dostałeś prawdopodobnie skrzynię lub EXP (sprawdź historię dropów na stronie)');
      logger.info(`🎲 [${userId}] Brak nowych skinów (prawdopodobnie EXP lub skrzynka)`);
    } else {
      const skinsWithValue = newItems.map(item =>
        `✨ ${item.name} (${(item.value * 4).toFixed(2)} zł)`
      ).join('\n');

      await bot.telegram.sendMessage(userId, `🎁 Otrzymałeś z Daily Case:\n\n${skinsWithValue}`);
      logger.info(`✨ [${userId}] Nowe itemy: ${newItems.length} (${newItems.map(i => i.name).join(', ')})`);
    }

    // Odczytaj nowy timer ze strony po otwarciu
    await new Promise(resolve => setTimeout(resolve, 1500));
    const newTimerText = await page.evaluate(() => {
      const container = document.querySelector('.top-options');
      const btn = container ? container.querySelector('.G_Button.big.max') : null;
      if (btn && btn.classList.contains('block')) {
        const timeDiv = btn.querySelector('.button_text');
        return timeDiv ? timeDiv.textContent.trim() : null;
      }
      return null;
    });

    let newCooldownMs = null;
    if (newTimerText) {
      newCooldownMs = parseTimeToMs(newTimerText);
      logger.info(`⏱️ [${userId}] Nowy cooldown odczytany ze strony: ${newTimerText} (${formatTimeMs(newCooldownMs)})`);
    }

    return {
      success: true,
      newCooldownTime: newTimerText,
      newCooldownMs: newCooldownMs
    };

  } catch (error) {
    logger.error(`❌ [${userId}] Błąd otwierania daily case:`, error.message);
    if (!ctx.isSilent) await ctx.reply(`❌ Błąd: ${error.message}`);
    return false;
  }
}

// ====== SMART SCHEDULER & AUTOOPEN ENGINE ======

/**
 * Ustawia i zapisuje precyzyjny czas następnego wywołania
 */
function scheduleUserNext(userId, delayMs) {
  let session = activeSessions.get(userId);
  if (!session) {
    session = { isLoggedIn: true };
  }

  if (session.autoOpenTimeout) {
    clearTimeout(session.autoOpenTimeout);
    session.autoOpenTimeout = null;
  }

  const nextCaseTime = Date.now() + delayMs;
  session.autoOpenEnabled = true;
  session.nextCaseTime = nextCaseTime;

  // Uruchomienie precyzyjnego timera Node.js
  const timeout = setTimeout(async () => {
    logger.info(`⏰ [${userId}] Precyzyjny timer obudził Smart Scheduler!`);
    await runAutoOpenCheck(userId, false);
  }, delayMs);

  session.autoOpenTimeout = timeout;
  setSessionAndTrack(userId, session);

  // Aktualizacja w MongoDB
  User.findOneAndUpdate(
    { telegramId: userId },
    { autoOpenEnabled: true, nextCaseTime: nextCaseTime },
    { upsert: true }
  ).catch(e => logger.error(`⚠️ [${userId}] Błąd zapisu harmonogramu w bazie:`, e.message));

  const minutesLeft = Math.ceil(delayMs / 60000);
  const targetDateStr = new Date(nextCaseTime).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  logger.info(`🗓️ [${userId}] AutoOpen zaplanowany za ~${minutesLeft} min (godz. ${targetDateStr})`);
}

/**
 * Główna procedura wykonawcza AutoOpen:
 * 1. Otwiera przeglądarkę
 * 2. Sprawdza stan skrzynki
 * 3. Jeśli zablokowana: planuje następny cykl i zamyka przeglądarkę
 * 4. Jeśli dostępna: otwiera, wysyła drop, odczytuje nowy cooldown (~19h), planuje i zamyka przeglądarkę
 */
async function runAutoOpenCheck(userId, isManual = false) {
  if (autoOpenLocks.get(userId)) {
    logger.warn(`⚠️ [${userId}] AutoOpen już w trakcie wykonywania, pomijam duplikat`);
    return;
  }

  autoOpenLocks.set(userId, true);

  try {
    const silentCtx = {
      from: { id: parseInt(userId, 10) },
      isSilent: true,
      reply: async (text) => {
        logger.info(`[${userId}] AutoOpen: ${text}`);
      }
    };

    const sessionObj = await ensureBrowserOpen(userId, silentCtx);
    if (!sessionObj) {
      logger.error(`❌ [${userId}] AutoOpen: Nie udało się przygotować zalogowanej sesji`);
      // Retry za 15 minut
      scheduleUserNext(userId, 15 * 60 * 1000);
      return;
    }

    const checkResult = await checkDailyCase(silentCtx);

    if (!checkResult || !checkResult.found) {
      logger.warn(`⚠️ [${userId}] AutoOpen: Nie znaleziono przycisku daily case, ponawiam za 5 min`);
      await closeBrowserSilently(userId);
      scheduleUserNext(userId, 5 * 60 * 1000);
      return;
    }

    if (checkResult.blocked) {
      // Skrzynka zablokowana – wylicz czas + 5 sekund bufora bezpieczeństwa
      const delay = (checkResult.timeMs || parseTimeToMs(checkResult.time)) + 5000;
      const minutesLeft = Math.ceil(delay / 60000);
      const targetTime = new Date(Date.now() + delay).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });

      // Natychmiast zwalniamy RAM zamykając przeglądarkę
      await closeBrowserSilently(userId);

      // Zaplanuj kolejne obudzenie
      scheduleUserNext(userId, delay);

      if (isManual) {
        await bot.telegram.sendMessage(
          userId,
          `⏳ Daily case dostępny za ${checkResult.timeFormatted || checkResult.time}\n` +
          `🔔 AutoOpen otworzy skrzynkę automatycznie o godz. ${targetTime} (za ~${minutesLeft} min)`
        );
      } else {
        logger.info(`[${userId}] AutoOpen: case zablokowany (${checkResult.timeFormatted}), sprawdzam o ${targetTime}`);
      }

    } else {
      // Skrzynka gotowa do otwarcia!
      logger.info(`🎁 [${userId}] AutoOpen: Daily case jest gotowy! Otwieram...`);
      await bot.telegram.sendMessage(userId, '🎁 Daily case jest dostępny! Otwieram automatycznie...');

      const openResult = await openDailyCase(silentCtx);

      // Po otwarciu ustalamy kolejny cykl (odczytany ze strony lub domyślnie 19h 40m)
      let nextDelay = (19 * 3600 + 40 * 60) * 1000 + 5000;

      if (openResult && openResult.newCooldownMs && openResult.newCooldownMs > 60000) {
        nextDelay = openResult.newCooldownMs + 5000;
      }

      const nextHours = (nextDelay / 3600000).toFixed(1);
      const nextTargetTime = new Date(Date.now() + nextDelay).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });

      // Zwalniamy RAM
      await closeBrowserSilently(userId);

      // Planujemy kolejny dzień
      scheduleUserNext(userId, nextDelay);

      await bot.telegram.sendMessage(
        userId,
        `⏳ Następny daily case za ~${nextHours}h (godz. ${nextTargetTime}).\nSmart Scheduler czuwa w tle!`
      );
    }

  } catch (err) {
    logger.error(`❌ [${userId}] Błąd w trakcie runAutoOpenCheck:`, err);
    await closeBrowserSilently(userId);
    scheduleUserNext(userId, 5 * 60 * 1000);
  } finally {
    autoOpenLocks.delete(userId);
  }
}

/**
 * Rozpoczęcie AutoOpen przez użytkownika
 */
async function startAutoOpen(ctx) {
  const userId = ctx.from.id.toString();

  // Sprawdź czy użytkownik ma zapisane dane lub cookies
  const user = await loadUser(userId);
  const cookies = await loadSessionCookies(userId);
  const hasAuth = (user?.steamUsername && user?.steamPassword) || (cookies && cookies.length > 0);

  if (!hasAuth) {
    await ctx.reply('❌ Nie jesteś zalogowany ani nie masz zapisanych danych!\nUżyj /login lub /setsteam');
    return;
  }

  let session = activeSessions.get(userId);
  if (!session) {
    session = { isLoggedIn: true };
    setSessionAndTrack(userId, session);
  }

  await ctx.reply('🔄 Smart Scheduler (AutoOpen) uruchomiony!\nSprawdzam skrzynkę...');
  logger.info(`▶️ [${userId}] AutoOpen uruchomiony ręcznie komendą /autoopen`);

  await runAutoOpenCheck(userId, true);
}

/**
 * Zatrzymanie AutoOpen
 */
async function stopAutoOpen(ctx) {
  const userId = ctx.from.id.toString();
  const session = activeSessions.get(userId);

  if (session?.autoOpenTimeout) {
    clearTimeout(session.autoOpenTimeout);
    session.autoOpenTimeout = null;
  }

  if (session) {
    session.autoOpenEnabled = false;
    session.nextCaseTime = null;
    setSessionAndTrack(userId, session);
  }

  await User.findOneAndUpdate(
    { telegramId: userId },
    { autoOpenEnabled: false, nextCaseTime: null }
  ).catch(() => {});

  lastWatchdogLogTime.delete(userId);
  logger.info(`⏹️ [${userId}] AutoOpen zatrzymany`);
  await ctx.reply('⏹️ Smart Scheduler (AutoOpen) został zatrzymany.');
}

/**
 * Watchdog: Okresowo (co 30s) weryfikuje stan odliczania w tle.
 * Jeśli nadszedł czas – natychmiast odpala otwieranie.
 * Co ~10 minut sporadycznie loguje w konsoli ile zostało bez spamu usera.
 */
function startAutoOpenWatchdog() {
  setInterval(async () => {
    try {
      const now = Date.now();

      // Pobierz wszystkich aktywnych z bazy danych dla pewności
      const activeUsers = await User.find({ autoOpenEnabled: true }).catch(() => []);

      for (const userDoc of activeUsers) {
        const userId = userDoc.telegramId;
        const nextCaseTime = userDoc.nextCaseTime;

        if (!nextCaseTime) continue;

        const remainingMs = nextCaseTime - now;

        // Jeśli czas nadszedł i nie trwa właśnie otwieranie
        if (remainingMs <= 0) {
          if (!autoOpenLocks.get(userId)) {
            logger.info(`⏰ [Watchdog] [${userId}] Czas nadszedł! Uruchamiam sprawdzanie/otwieranie skrzynki...`);
            runAutoOpenCheck(userId, false);
          }
        } else {
          // Logowanie w tle co 10 minut w konsoli
          const lastLog = lastWatchdogLogTime.get(userId) || 0;
          if (now - lastLog > 10 * 60 * 1000) {
            lastWatchdogLogTime.set(userId, now);
            const minsLeft = Math.ceil(remainingMs / 60000);
            const targetTimeStr = new Date(nextCaseTime).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
            logger.info(`⏱️ [Watchdog] [${userId}] AutoOpen odlicza w tle: pozostało ~${minsLeft} min (otwarcie o ${targetTimeStr})`);
          }
        }
      }
    } catch (e) {
      logger.error('⚠️ Błąd w AutoOpen Watchdog loop:', e.message);
    }
  }, 30 * 1000);
}

/**
 * Przywracanie AutoOpen po restarcie serwera / bota
 */
async function restoreAutoOpenTasks() {
  try {
    const users = await User.find({ autoOpenEnabled: true });
    if (users.length === 0) return;

    logger.info(`🔄 Przywracanie AutoOpen dla ${users.length} użytkowników...`);

    for (const user of users) {
      const userId = user.telegramId;
      const now = Date.now();

      let delay = user.nextCaseTime ? (user.nextCaseTime - now) : 5000;
      if (delay < 0) {
        delay = 5000 + Math.floor(Math.random() * 10000);
      }

      let session = activeSessions.get(userId);
      if (!session) {
        session = { isLoggedIn: true, autoOpenEnabled: true, nextCaseTime: user.nextCaseTime };
        setSessionAndTrack(userId, session);
      }

      logger.info(`🗓️ [${userId}] AutoOpen przywrócony - sprawdzenie nastąpi za ~${Math.round(delay / 60000)} min`);
      scheduleUserNext(userId, delay);
    }
  } catch (e) {
    logger.error('❌ Błąd podczas przywracania AutoOpen z bazy danych:', e.message);
  }
}

// ====== TELEGRAM COMMANDS ======

const commands = [
  { command: '/start', description: 'Wszystkie komendy' },
  { command: '/login', description: 'Wybierz metodę logowania' },
  { command: '/autoopen', description: 'Włącz Smart Scheduler' },
  { command: '/checkstatus', description: 'Status Smart Schedulera' },
  { command: '/check', description: 'Sprawdź daily case' },
  { command: '/open', description: 'Otwórz daily case' },
  { command: '/stop', description: 'Zatrzymaj Smart Scheduler' },
  { command: '/close', description: 'Zamknij okno przeglądarki' },
];

bot.command('start', (ctx) => {
  ctx.reply(
    '🤖 G4Skins Daily Case Bot\n\n' +
    '📋 Komendy:\n' +
    '/setsteam - Zapisz dane Steam (login:hasło)\n' +
    '/setpin - Zapisz PIN Family View (PIN:1234)\n' +
    '/login - Wybierz metodę logowania\n' +
    '/check - Sprawdź status daily case\n' +
    '/open - Otwórz daily case\n' +
    '/autoopen - Włącz Smart Scheduler (AutoOpen)\n' +
    '/checkstatus - Status AutoOpen\n' +
    '/stop - Zatrzymaj AutoOpen\n' +
    '/logout - Wyloguj się i usuń sesję\n' +
    '/resetall - ZAMKNIJ WSZYSTKIE SESJE (admin)\n' +
    '/close - Zamknij przeglądarkę (oszczędność RAM)\n' +
    '/dbtest - Sprawdź status bazy danych\n' +
    '/status - Sprawdź status sesji\n\n' +
    '💡 Smart Scheduler (AutoOpen):\n' +
    '• Precyzyjnie odlicza czas do następnej skrzynki\n' +
    '• Zamyka przeglądarkę w tle, oszczędzając pamięć RAM\n' +
    '• Samodzielnie otwiera skrzynkę w wyznaczonym czasie i wysyła drop\n' +
    '• Pamięta harmonogram po restarcie bota i kontynuuje działanie bez przerwy'
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
⏰ NextCaseTime: ${user.nextCaseTime ? new Date(user.nextCaseTime).toLocaleString('pl-PL') : 'Brak'}
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

bot.command('checkstatus', async (ctx) => {
  const userId = ctx.from.id.toString();
  const session = activeSessions.get(userId);
  const user = await loadUser(userId);

  const isAutoOpen = session?.autoOpenEnabled || user?.autoOpenEnabled;
  const nextTime = session?.nextCaseTime || user?.nextCaseTime;

  if (!isAutoOpen) {
    ctx.reply('⚠️ AutoOpen nie jest włączony\n\nUżyj /autoopen aby uruchomić Smart Scheduler');
    return;
  }

  let statusText = '✅ Smart Scheduler (AutoOpen) jest aktywny\n\n';
  statusText += '⏱️ Tryb: Inteligentny harmonogram w tle\n';
  statusText += '🎁 Auto otwieranie: Włączone\n';
  statusText += '🔄 Samoczynna kontynuacja: Tak (24/7)\n';

  if (nextTime && nextTime > Date.now()) {
    const remainingMs = nextTime - Date.now();
    const timeFormatted = formatTimeMs(remainingMs);
    const minutesLeft = Math.ceil(remainingMs / 60000);
    const targetDate = new Date(nextTime).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });

    statusText += `\n⏰ Czas do skrzynki: ${timeFormatted} (~${minutesLeft} min)\n`;
    statusText += `🔔 Planowane automatyczne otwarcie: godz. ${targetDate}`;
  } else {
    statusText += '\n⏰ Status: Gotowy do otwarcia!';
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

  ctx.deleteMessage().catch(() => {});
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

  ctx.deleteMessage().catch(() => {});
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
    return;
  }
  try {
    await ctx.editMessageText('🔄 Logowanie przez login i hasło...');
  } catch (e) {}
  await loginToSteam(ctx, 'password');
});

bot.action('login_qr', async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (e) {
    return;
  }
  try {
    await ctx.editMessageText('🔄 Logowanie przez QR code...');
  } catch (e) {}
  await loginToSteam(ctx, 'qr');
});

bot.command('check', checkDailyCase);
bot.command('open', openDailyCase);
bot.command('autoopen', startAutoOpen);
bot.command('stop', stopAutoOpen);

bot.command('close', async (ctx) => {
  const userId = ctx.from.id.toString();
  const session = activeSessions.get(userId);

  if (session?.browser) {
    try {
      await session.browser.close();
      logger.info(`🚪 [${userId}] Przeglądarka zamknięta ręcznie`);
    } catch (e) {
      logger.error(`⚠️ [${userId}] Błąd zamykania przeglądarki:`, e.message);
    }
    session.browser = null;
    session.page = null;
    setSessionAndTrack(userId, session);

    ctx.reply('🚪 Okienko przeglądarki zostało zamknięte.\nSesja i harmonogram AutoOpen działają nadal w tle.');
  } else {
    ctx.reply('ℹ️ Przeglądarka jest już uśpiona/zamknięta w tle.');
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
    sessionCreationTime.delete(userId);
    autoOpenLocks.delete(userId);
    lastWatchdogLogTime.delete(userId);

    await Session.deleteOne({ telegramId: userId });
    await User.findOneAndUpdate({ telegramId: userId }, { autoOpenEnabled: false, nextCaseTime: null }).catch(() => {});

    ctx.reply('👋 Wylogowano i usunięto sesję.');
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
      }

      if (session.browser) {
        await session.browser.close();
      }
      closedCount++;
    } catch (e) {
      logger.error(`⚠️ [${userId}] Błąd zamykania przeglądarki przy reset:`, e.message);
    }
  }

  activeSessions.clear();
  sessionCreationTime.clear();
  autoOpenLocks.clear();
  lastWatchdogLogTime.clear();

  try {
    await Session.deleteMany({});
    await User.updateMany({}, { autoOpenEnabled: false, nextCaseTime: null });
    logger.info('🗑️ Wszystkie zapisane sesje usunięte z bazy danych');
  } catch (e) {
    logger.error('⚠️ Błąd usuwania sesji z bazy:', e.message);
  }

  await ctx.reply(`🔄 Reset zakończony!\nZamknięto ${closedCount} aktywnych sesji.\nWszystkie dane wyczyszczone.`);
  logger.info(`✅ [RESETALL] Reset zakończony - zamknięto ${closedCount} sesji`);
});

bot.command('status', async (ctx) => {
  const userId = ctx.from.id.toString();
  const session = activeSessions.get(userId);
  const user = await loadUser(userId);

  if (!session && !user) {
    ctx.reply('❌ Nie jesteś zarejestrowany');
    return;
  }

  const browserStatus = session?.browser && session.browser.isConnected() ? '✅ Aktywna' : '💤 Uśpiona w tle';
  const isAutoOpen = session?.autoOpenEnabled || user?.autoOpenEnabled;
  const nextTime = session?.nextCaseTime || user?.nextCaseTime;

  let autoOpenStr = '❌ Wyłączony';
  if (isAutoOpen) {
    if (nextTime && nextTime > Date.now()) {
      const mins = Math.ceil((nextTime - Date.now()) / 60000);
      const targetTimeStr = new Date(nextTime).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
      autoOpenStr = `✅ Włączony (otwarcie o ${targetTimeStr}, za ~${mins} min)`;
    } else {
      autoOpenStr = '✅ Włączony (oczekiwanie na sprawdzenie)';
    }
  }

  const status =
    `📊 Status sesji:\n\n` +
    `✅ Zalogowany: ${(session?.isLoggedIn || user?.steamUsername) ? 'Tak' : 'Nie'}\n` +
    `🔐 Metoda: ${session?.loginMethod || (user?.steamUsername ? 'Steam credentials' : 'Brak')}\n` +
    `🌐 Przeglądarka: ${browserStatus}\n` +
    `🔄 AutoOpen: ${autoOpenStr}`;

  ctx.reply(status);
});

// ====== START APLIKACJI ======

async function startBot() {
  logger.info('🚀 Uruchamiam bota...');

  logger.info('📦 Łączę z MongoDB...');
  const dbConnected = await connectDB();

  if (!dbConnected) {
    logger.error('❌ Nie można połączyć z MongoDB - kończę!');
    process.exit(1);
  }

  await bot.telegram.setMyCommands(commands).catch(() => {});
  await bot.telegram.setChatMenuButton({
    menu_button: {
      type: 'commands',
      text: 'Menu'
    }
  }).catch(() => {});

  logger.info('🤖 MongoDB połączony - uruchamiam bota Telegram...');

  try {
    await bot.launch();
    logger.info('✅ Bot uruchomiony pomyślnie!');
    logger.info('🎯 Bot gotowy do pracy - wyślij /start w Telegramie');

    // Uruchom Watchdog i przywróć zadania AutoOpen z MongoDB
    startAutoOpenWatchdog();
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
      } catch (e) {}
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
      } catch (e) {}
    }
  }
  bot.stop('SIGTERM');
  process.exit(0);
});
