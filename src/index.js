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
const browserSession = require('./browser-session');
const {OperationGate} = require('./operation-gate');
const claim = require('./daily-claim');
const operations = new OperationGate();
const scheduleWrites = new Map();
let maintenance = false;
const chromium = require('@sparticuz/chromium');
const logger = require('./logger');

puppeteer.use(StealthPlugin());

// Railway ustawia RAILWAY_ENVIRONMENT
const isProduction = !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';

// Konfiguracja Puppeteer
const getPuppeteerConfig = async () => {
  if (isProduction) {
    const systemChromium = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (systemChromium) {
      fs.accessSync(systemChromium, fs.constants.X_OK);
      return {
        executablePath: systemChromium,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        defaultViewport: { width: 1366, height: 768 },
      };
    }
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
  nextCaseTime: { type: Number, default: null },
  scheduleReason: String,
  lastDailyAttempt: mongoose.Schema.Types.Mixed
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
  if(maintenance)return;
  for(const [userId,session] of activeSessions) {
    await operations.run(userId,'cleanup',async()=>{
      if(maintenance || session.previewUntil>Date.now() || session.verificationRequired)return;
      const idleTime=Date.now()-(sessionCreationTime.get(userId)||0);
      if(idleTime<=CONFIG.SESSION_IDLE_TIMEOUT)return;
      if(session.browser) {
        try {await session.browser.close();}
        catch(error){logger.warn('['+userId+'] Cleanup: '+error.message);}
        session.browser=null;session.page=null;
      }
      if(session.autoOpenEnabled || session.autoOpenTimeout)return;
      activeSessions.delete(userId);sessionCreationTime.delete(userId);
      autoOpenLocks.delete(userId);lastWatchdogLogTime.delete(userId);
    });
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
      {$set:Object.fromEntries(['steamUsername','steamPassword','familyViewPin'].filter(key=>user[key]!==undefined).map(key=>[key,user[key]]))},
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
          browser = isProduction ? await browserSession.launchBrowser(userId, config) : await puppeteer.launch({
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

      const page = await browserSession.getPage(browser);

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


      await page.setViewport({ width: 1366, height: 768 });

      const savedCookies = await loadSessionCookies(userId);
      if (savedCookies && Array.isArray(savedCookies) && savedCookies.length > 0) {
        const cleanedCookies = savedCookies.map(({ partitionKey, ...rest }) => rest);
        await browserSession.restoreCookies(page, cleanedCookies);
        await page.goto(CONFIG.URLS.G4SKINS_DAILY, { waitUntil: 'networkidle2' }).catch(() => {});

        if (/just a moment|attention required|access denied/i.test(await page.title())) {
          try { await daily.waitForDailyButton(page); }
          catch (error) {
            await holdBrowserForVerification(userId,browser,page);
            await ctx.reply(error.message);
            return false;
          }
        }
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


    await page.goto(CONFIG.URLS.G4SKINS_DAILY, { waitUntil: 'networkidle2' });

    try {
      await page.waitForSelector(SELECTORS.g4skins.loginForm, { timeout: 10000 });
    } catch (e) {
      const alreadyLoggedIn = await page.evaluate(() => {
        return !document.querySelector('.login-form-content');
      });

      if (alreadyLoggedIn) {
        if (!ctx.isSilent) await ctx.reply('✅ Jesteś zalogowany.');
        session.isLoggedIn = true;
        setSessionAndTrack(userId, session);
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }



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
      if (!ctx.isSilent) await ctx.reply('✅ Zalogowano.');
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
      browser = isProduction ? await browserSession.launchBrowser(userId, config) : await puppeteer.launch({
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

  const page = await browserSession.getPage(browser);

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
    await browserSession.restoreCookies(page, cleanedCookies);
    await page.goto(CONFIG.URLS.G4SKINS_DAILY, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

    if (/just a moment|attention required|access denied/i.test(await page.title())) {
      session = session || {};
      session.browser = browser;
      session.page = page;
      session.verificationRequired = true;
      setSessionAndTrack(userId,session);
      return session;
    }
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
  if (activeSessions.get(userId)?.verificationRequired || activeSessions.get(userId)?.previewUntil>Date.now()) return;
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

const daily = require('./daily-case');

async function saveAttempt(userId, attempt) {
  await User.findOneAndUpdate({telegramId:userId}, {$set:{lastDailyAttempt:attempt}}, {upsert:true});
  const session=activeSessions.get(userId);
  if(session) session.lastDailyAttempt=attempt;
  logger.info(`[${userId}] Daily attempt: ${attempt.status}; phase=${attempt.phase}; code=${attempt.code||'-'}`);
}

function historyReward(row) {
  if(row?.type==='exp' && row.amount) return `${row.amount} EXP`;
  if(row?.name) return `${row.type==='case'?'skrzynka ':''}${row.name} (${row.value})`;
  return null;
}

async function reconcileAttempt(userId, page, attempt, info) {
  let row=null;
  try { row=await daily.readHistoryInTab(page); }
  catch(error){logger.warn(`[${userId}] Uzgadnianie historii: ${error.message}`);}
  const changed=attempt.previousSignature && row?.signature!==attempt.previousSignature && row?.type!=='empty';
  const cooldown=info.blocked?daily.parseCooldown(info.time):null;
  if(changed || cooldown>0) {
    const confirmed={...attempt,status:'confirmed',phase:'reconciled',finishedAt:Date.now(),
      reward:changed?historyReward(row):attempt.reward||null,cooldownMs:cooldown,
      code:changed?'HISTORY_CHANGED':'COOLDOWN_CONFIRMED'};
    await saveAttempt(userId,confirmed);
    return {success:true,reward:confirmed.reward,newCooldownMs:cooldown,cooldownKnown:cooldown>0,reconciled:true};
  }
  // No repeat click until the user has checked history and explicitly released it.
  return {success:false,pending:true,error:'Poprzednie kliknięcie pozostaje niepotwierdzone. Bot sprawdza wynik bez ponownego otwierania. Szczegóły: /lastopen. Po sprawdzeniu historii: /retryopen.'};
}

async function checkDailyCase(ctx) {
  const userId = ctx.from.id.toString();
  const session = await ensureBrowserOpen(userId, ctx);
  if (!session?.page || !session.browser?.isConnected()) {
    if (!ctx.isSilent) await ctx.reply('Brak aktywnej sesji. Zaloguj się poleceniem /login.');
    return {found:false,error:'Brak aktywnej sesji. Użyj /login.'};
  }
  try {
    const info = await daily.goToDaily(session.page,{refresh:true});
    session.verificationRequired = false;
    await saveSessionCookies(userId, await session.page.cookies());
    if(!info.actionable)throw new Error('Strona wymaga logowania lub spełnienia warunków Daily Case. Użyj /verify.');
    if(info.loading)throw new Error('Strona nadal przetwarza otwarcie. Sprawdź /lastopen lub /reconcile.');
    if (info.blocked) {
      const timeMs = daily.parseCooldown(info.time);
      if (timeMs===null) throw new Error('Daily Case jest zablokowany, ale strona nie podała czasu odblokowania.');
      const timeFormatted = formatTimeMs(timeMs);
      if (!ctx.isSilent) await ctx.reply(`Daily Case jest zablokowany. Dostępny za ${timeFormatted} (godz. ${daily.formatNext(Date.now()+timeMs)}, czas polski).`);
      return {...info,timeMs,timeFormatted};
    }
    if (!ctx.isSilent) await ctx.reply('Daily Case jest dostępny. Użyj /open, aby go otworzyć.');
    return info;
  } catch (error) {
    if (error.code === 'SITE_VERIFICATION') await holdBrowserForVerification(userId, session.browser, session.page);
    logger.warn(`[${userId}] Sprawdzenie Daily Case: ${error.message}`);
    if (!ctx.isSilent) await ctx.reply(error.message);
    return {found:false,error:error.message,code:error.code};
  }
}

async function readInventory(page) {
  return page.evaluate(async apiUrl => {
    const response = await fetch(apiUrl,{credentials:'include'});
    if (!response.ok) throw new Error(`Nie udało się odczytać ekwipunku (HTTP ${response.status}).`);
    const data = await response.json();
    if (!Array.isArray(data.result)) throw new Error('Nieprawidłowa odpowiedź ekwipunku.');
    return data.result.map(item=>({name:item.name,value:item.value}));
  },CONFIG.URLS.G4SKINS_API_INVENTORY);
}

async function openDailyCase(ctx) {
  const userId=ctx.from.id.toString();
  let observer, attempt;
  try {
    const session=await ensureBrowserOpen(userId,ctx);
    if(!session?.page || !session.browser?.isConnected()) throw new Error('Brak aktywnej sesji. Użyj /login.');
    const {page}=session;
    const user=await User.findOne({telegramId:userId});
    attempt=user?.lastDailyAttempt;
    let info=await daily.goToDaily(page,{refresh:true});
    if(attempt?.status==='pending') {
      const result=await reconcileAttempt(userId,page,attempt,info);
      if(!ctx.isSilent) await ctx.reply(result.success?daily.formatOpened(result.reward,Date.now()+(result.newCooldownMs||300000),result.cooldownKnown):result.error);
      return result;
    }
    if(info.blocked) {
      const timeMs=daily.parseCooldown(info.time);
      if(timeMs===null) throw new Error('Daily Case jest zablokowany, ale strona nie podała czasu odblokowania.');
      if(!ctx.isSilent) await ctx.reply('Daily Case jest zablokowany. Dostępny za '+formatTimeMs(timeMs)+' (godz. '+daily.formatNext(Date.now()+timeMs)+').');
      return {success:false,blocked:true,timeMs};
    }
    let previousReward=null, before=[];
    try {previousReward=await daily.readHistoryInTab(page);}
    catch(error){logger.warn('['+userId+'] Historia przed otwarciem: '+error.message);}
    try {before=await readInventory(page);}
    catch(error){logger.warn('['+userId+'] Ekwipunek przed otwarciem: '+error.message);before=null;}
    await page.bringToFront();
    observer=await claim.observeClaim(page);
    const clicked=await daily.clickDailyButton(page,async()=>{
      if(ctx.generation!==undefined && !operations.current(userId,ctx.generation))throw new Error('AutoOpen został zatrzymany przed kliknięciem.');
      attempt={status:'pending',phase:'click',startedAt:Date.now(),previousSignature:previousReward?.signature||null};
      // Persist before the only opening click, including across process crashes.
      await saveAttempt(userId,attempt);
    });
    if(clicked.blocked) return {success:false,blocked:true,timeMs:daily.parseCooldown(clicked.time)||300000};
    const response=await observer.result;
    await observer.dispose();observer=null;
    attempt={...attempt,phase:'ack',code:response.code};
    if(response.status==='rejected') {
      attempt={...attempt,status:'rejected',finishedAt:Date.now()};
      await saveAttempt(userId,attempt);
      throw new Error('G4Skins odrzucił otwarcie Daily Case. Sprawdź komunikat strony przez /preview oraz /diagnose.');
    }
    if(response.status==='confirmed') {
      attempt={...attempt,status:'confirmed',code:'DAILY_ACK_CONFIRMED',finishedAt:Date.now(),reward:claim.rewardText(response.reward),rewardType:response.reward.type};
      await saveAttempt(userId,attempt);
    } else await saveAttempt(userId,attempt);
    // Claim acknowledgment precedes a six-second animation and a second socket
    // request refreshing cooldown. Await the actual transition before navigation.
    let cooldown=null;
    try {
      const handle=await page.waitForFunction(()=>{
        const button=[...document.querySelectorAll('.top-options .G_Button.big')].find(el=>el.getClientRects().length);
        const text=button?.querySelector('.button_text')?.textContent.trim();
        return button?.disabled && !button.querySelector('.button_load') && /^\d+\s*:\s*\d{2}\s*:\s*\d{2}$/.test(text)?text:false;
      },{timeout:30000,polling:250});
      try {cooldown=daily.parseCooldown(await handle.jsonValue());}finally{await handle.dispose();}
    } catch(error){logger.warn('['+userId+'] Oczekiwanie na cooldown: '+error.name);}
    let latest=null, reward=attempt.reward||null, inventoryConfirmed=false;
    try {
      const row=await daily.readHistoryInTab(page);
      if(previousReward && row?.signature!==previousReward.signature && row.type!=='empty')latest=row;
    }catch(error){logger.warn('['+userId+'] Historia po otwarciu: '+error.message);}
    if(latest)reward=historyReward(latest);
    if(!reward && before) {
      try {
        const remaining=[...before];
        const items=(await readInventory(page)).filter(item=>{const i=remaining.findIndex(old=>old.name===item.name);if(i<0)return true;remaining.splice(i,1);return false;});
        if(items.length){reward=items.map(item=>item.name+' ('+(item.value*4).toFixed(2)+' zł)').join('\n');inventoryConfirmed=true;}
      }catch(error){logger.warn('['+userId+'] Ekwipunek po otwarciu: '+error.message);}
    }
    if(response.status!=='confirmed' && !latest && !cooldown && !inventoryConfirmed) {
      await saveAttempt(userId,{...attempt,status:'pending',phase:'confirmation',code:response.code});
      return await pendingReply(ctx);
    }
    await saveAttempt(userId,{...attempt,status:'confirmed',phase:'complete',finishedAt:Date.now(),reward,cooldownMs:cooldown});
    const result={success:true,reward,newCooldownMs:cooldown,cooldownKnown:cooldown>0};
    if(!ctx.isSilent)await ctx.reply(daily.formatOpened(reward,Date.now()+(cooldown||300000),result.cooldownKnown));
    return result;
  }catch(error){
    const current=activeSessions.get(userId);
    if(error.code==='SITE_VERIFICATION' && current?.browser)await holdBrowserForVerification(userId,current.browser,current.page);
    logger.error('['+userId+'] Otwarcie Daily Case: '+error.message);
    // Once a click may have happened, errors cannot release the durable guard.
    if(attempt?.status==='pending')return pendingReply(ctx);
    if(!ctx.isSilent)await ctx.reply(error.message);
    return {success:false,error:error.message,code:error.code};
  }finally{if(observer)await observer.dispose();}
}

async function pendingReply(ctx) {
  const result={success:false,pending:true,error:'Nie udało się jeszcze potwierdzić otwarcia. Bot sprawdzi wynik bez kolejnego kliknięcia. Szczegóły: /lastopen i /diagnose.'};
  if(!ctx.isSilent)await ctx.reply(result.error);
  return result;
}

// ====== SMART SCHEDULER & AUTOOPEN ENGINE ======

/**
 * Ustawia i zapisuje precyzyjny czas następnego wywołania
 */
async function scheduleUserNext(userId, delayMs, generation=operations.generation(userId), reason='retry') {
  if(!operations.current(userId,generation)) return false;
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
  session.scheduleReason = reason;

  // Uruchomienie precyzyjnego timera Node.js
  const timeout = setTimeout(async () => {
    logger.info(`⏰ [${userId}] Precyzyjny timer obudził Smart Scheduler!`);
    await runAutoOpenCheck(userId, false).catch(error=>logger.error(`[${userId}] Timer AutoOpen: ${error.message}`));
  }, delayMs);

  session.autoOpenTimeout = timeout;
  setSessionAndTrack(userId, session);

  // Aktualizacja w MongoDB
  await persistSchedule(userId,{autoOpenEnabled:true,nextCaseTime,scheduleReason:reason});

  const minutesLeft = Math.ceil(delayMs / 60000);
  const targetDateStr = new Date(nextCaseTime).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });
  logger.info(`🗓️ [${userId}] AutoOpen zaplanowany za ~${minutesLeft} min (godz. ${targetDateStr})`);
  return operations.current(userId,generation);
}

function persistSchedule(userId, values) {
  const write=(scheduleWrites.get(userId)||Promise.resolve()).catch(()=>{}).then(()=>
    User.findOneAndUpdate({telegramId:userId},{$set:values},{upsert:true}));
  scheduleWrites.set(userId,write);
  write.finally(()=>{if(scheduleWrites.get(userId)===write)scheduleWrites.delete(userId);}).catch(()=>{});
  return write;
}

/**
 * Główna procedura wykonawcza AutoOpen:
 * 1. Otwiera przeglądarkę
 * 2. Sprawdza stan skrzynki
 * 3. Jeśli zablokowana: planuje następny cykl i zamyka przeglądarkę
 * 4. Jeśli dostępna: otwiera, wysyła drop, odczytuje nowy cooldown (~19h), planuje i zamyka przeglądarkę
 */
async function runAutoOpenCheck(userId, isManual = false) {
  if(maintenance)return;
  return operations.run(userId,'autoopen',()=>runAutoOpenCheckLocked(userId,isManual),async()=>{
    if(isManual)await bot.telegram.sendMessage(userId,'Inna operacja przeglądarki trwa. Poczekaj na jej zakończenie i ponów /autoopen.');
  });
}

async function runAutoOpenCheckLocked(userId, isManual = false) {
  const generation=operations.generation(userId);
  if(!isManual && activeSessions.get(userId)?.autoOpenEnabled===false)return;
  if (autoOpenLocks.get(userId)) {
    if (isManual) await bot.telegram.sendMessage(userId,'Sprawdzanie AutoOpen jest już w toku. Wynik pojawi się po zakończeniu.');
    return;
  }
  autoOpenLocks.set(userId,true);
  try {
    const silentCtx = {from:{id:parseInt(userId,10)},isSilent:true,generation,reply:async text=>logger.info(`[${userId}] AutoOpen: ${text}`)};
    const checkResult = await checkDailyCase(silentCtx);
    if (!checkResult?.found) {
      if(!await scheduleUserNext(userId,checkResult?.code === 'SITE_VERIFICATION' ? 30*60000 : 5*60000,generation))return;
      if (isManual) await bot.telegram.sendMessage(userId,
        `AutoOpen jest włączony.\n${checkResult?.error || 'Nie udało się sprawdzić statusu Daily Case.'}\n`+
        `Ponowne sprawdzenie o godz. ${daily.formatNext(activeSessions.get(userId).nextCaseTime)} (czas polski).`);
      return;
    }
    const stored=await User.findOne({telegramId:userId});
    if (checkResult.blocked && stored?.lastDailyAttempt?.status!=='pending') {
      if(!await scheduleUserNext(userId,checkResult.timeMs+5000,generation,'cooldown'))return;
      if (isManual) await bot.telegram.sendMessage(userId,
        `AutoOpen jest włączony. Daily Case jest obecnie zablokowany.\n`+
        `⏳ Następne automatyczne otwarcie o godz. ${daily.formatNext(activeSessions.get(userId).nextCaseTime)} (za ${checkResult.timeFormatted}, czas polski).\n`+
        'Harmonogram działa w tle. Status: /checkstatus. Zatrzymanie: /stop.');
      return;
    }
    if(!operations.current(userId,generation))return;
    const result = await openDailyCase(silentCtx);
    if (!result?.success) {
      if(!await scheduleUserNext(userId,result?.blocked ? result.timeMs+5000 : 5*60000,generation,result?.pending?'reconcile':result?.blocked?'cooldown':'retry'))return;
      await bot.telegram.sendMessage(userId,
        `AutoOpen jest włączony. ${result?.error || 'Daily Case nie został otwarty; status zostanie sprawdzony ponownie.'}\n`+
        `Następne sprawdzenie o godz. ${daily.formatNext(activeSessions.get(userId).nextCaseTime)} (czas polski).`);
      return;
    }
    const delay = result.newCooldownMs ? result.newCooldownMs+5000 : 5*60000;
    if(!await scheduleUserNext(userId,delay,generation,result.cooldownKnown?'cooldown':'retry'))return;
    await bot.telegram.sendMessage(userId,daily.formatOpened(result.reward,activeSessions.get(userId).nextCaseTime,result.cooldownKnown));
  } catch (error) {
    logger.error(`[${userId}] AutoOpen: ${error.message}`);
    if(!await scheduleUserNext(userId,5*60000,generation))return;
    if (isManual) await bot.telegram.sendMessage(userId,'AutoOpen jest włączony, ale sprawdzenie nie powiodło się. Ponowna próba za 5 minut.');
  } finally {
    await closeBrowserSilently(userId);
    autoOpenLocks.delete(userId);
  }
}


/**
 * Rozpoczęcie AutoOpen przez użytkownika
 */
async function startAutoOpen(ctx) {
  const userId = ctx.from.id.toString();
  const generation=operations.generation(userId);

  // Sprawdź czy użytkownik ma zapisane dane lub cookies
  const user = await loadUser(userId);
  const cookies = await loadSessionCookies(userId);
  const hasAuth = (user?.steamUsername && user?.steamPassword) || (cookies && cookies.length > 0);
  if(!operations.current(userId,generation))return;

  if (!hasAuth) {
    await ctx.reply('❌ Nie jesteś zalogowany ani nie masz zapisanych danych!\nUżyj /login lub /setsteam');
    return;
  }

  let session = activeSessions.get(userId);
  if (!session) {
    session = { isLoggedIn: true };
    setSessionAndTrack(userId, session);
  }

  await ctx.sendChatAction('typing').catch(() => {});
  if(!operations.current(userId,generation))return;
  logger.info(`▶️ [${userId}] AutoOpen uruchomiony ręcznie komendą /autoopen`);

  await runAutoOpenCheck(userId, true);
}

/**
 * Zatrzymanie AutoOpen
 */
async function stopAutoOpen(ctx) {
  const userId = ctx.from.id.toString();
  operations.cancel(userId);
  const session = activeSessions.get(userId) || {};

  if (session?.autoOpenTimeout) {
    clearTimeout(session.autoOpenTimeout);
    session.autoOpenTimeout = null;
  }

  if (session) {
    session.autoOpenEnabled = false;
    session.nextCaseTime = null;
    setSessionAndTrack(userId, session);
  }

  await persistSchedule(userId,{autoOpenEnabled:false,nextCaseTime:null,scheduleReason:null});

  lastWatchdogLogTime.delete(userId);
  logger.info(`⏹️ [${userId}] AutoOpen zatrzymany`);
  await ctx.reply('AutoOpen został zatrzymany.');
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
        if(activeSessions.get(userId)?.autoOpenEnabled===false)continue;
        const nextCaseTime = userDoc.nextCaseTime;

        if (!nextCaseTime) continue;

        const remainingMs = nextCaseTime - now;

        // Jeśli czas nadszedł i nie trwa właśnie otwieranie
        if (remainingMs <= 0) {
          if (!autoOpenLocks.get(userId)) {
            logger.info(`⏰ [Watchdog] [${userId}] Czas nadszedł! Uruchamiam sprawdzanie/otwieranie skrzynki...`);
            runAutoOpenCheck(userId, false).catch(error=>logger.error(`[${userId}] Watchdog AutoOpen: ${error.message}`));
          }
        } else {
          // Logowanie w tle co 10 minut w konsoli
          const lastLog = lastWatchdogLogTime.get(userId) || 0;
          if (now - lastLog > 10 * 60 * 1000) {
            lastWatchdogLogTime.set(userId, now);
            const minsLeft = Math.ceil(remainingMs / 60000);
            const targetTimeStr = new Date(nextCaseTime).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });
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
      await scheduleUserNext(userId, delay,operations.generation(userId),user.scheduleReason||'retry');
    }
  } catch (e) {
    logger.error('❌ Błąd podczas przywracania AutoOpen z bazy danych:', e.message);
  }
}

// ====== TELEGRAM COMMANDS ======

// Serialize every command/callback that can navigate, disconnect or close the
// user's Chromium. Scheduler owns the same gate for its complete transaction.
const browserCommands=new Set(['check','open','verify','close','logout','reconcile','retryopen','preview']);
bot.use(async(ctx,next)=>{
  const command=ctx.message?.text?.match(/^\/(\w+)(?:@\w+)?(?:\s|$)/)?.[1]?.toLowerCase();
  if(!browserCommands.has(command) && !/^login_(qr|password)$/.test(ctx.callbackQuery?.data||''))return next();
  if(maintenance)return ctx.reply('Trwa administracyjny reset sesji. Spróbuj ponownie po jego zakończeniu.');
  const userId=String(ctx.from.id);
  return operations.run(userId,command||'login',next,async name=>{
    if(ctx.callbackQuery)await ctx.answerCbQuery().catch(()=>{});
    await ctx.reply(`Trwa operacja: ${name}. Poczekaj na jej zakończenie. Status bez zmiany strony: /diagnose.`);
  });
});

const registeredCommands=new Set();
const registerCommand=bot.command.bind(bot);
bot.command=(name,...handlers)=>{
  if(registeredCommands.has(name))throw new Error('Duplicate Telegram command: '+name);
  registeredCommands.add(name);return registerCommand(name,...handlers);
};

const commands = [
  { command: '/start', description: 'Wszystkie komendy' },
  { command: '/login', description: 'Wybierz metodę logowania' },
  { command: '/verify', description: 'Ręczna weryfikacja dostępu G4Skins' },
  { command: '/autoopen', description: 'Włącz Smart Scheduler' },
  { command: '/checkstatus', description: 'Status Smart Schedulera' },
  { command: '/check', description: 'Sprawdź daily case' },
  { command: '/open', description: 'Otwórz daily case' },
  { command: '/stop', description: 'Zatrzymaj Smart Scheduler' },
  { command: '/close', description: 'Zamknij okno przeglądarki' },
  { command: '/diagnose', description: 'Diagnostyka bez zmiany strony' },
  { command: '/lastopen', description: 'Wynik i etap ostatniego otwarcia' },
  { command: '/reconcile', description: 'Sprawdź wynik bez kolejnego kliknięcia' },
  { command: '/retryopen', description: 'Odblokuj próbę po sprawdzeniu historii' },
  { command: '/preview', description: 'Podgląd przeglądarki na 30 minut' },
];

bot.command('start', (ctx) => {
  ctx.reply(
    '🤖 G4Skins Daily Case Bot\n\n' +
    '📋 Komendy:\n' +
    '/setsteam - Zapisz dane Steam (login:hasło)\n' +
    '/setpin - Zapisz PIN Family View (PIN:1234)\n' +
    '/login - Wybierz metodę logowania\n' +
    '/verify - Ręczna weryfikacja w przeglądarce serwera\n' +
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
    '/diagnose - Diagnostyka bez zmiany strony\n' +
    '/lastopen - Etap i wynik ostatniej próby\n' +
    '/reconcile - Uzgodnij wynik z historią bez otwierania\n' +
    '/retryopen - Odblokuj niepewną próbę po sprawdzeniu historii\n' +
    '/preview [off] - Podgląd przeglądarki na 30 minut\n\n' +
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
🔢 PIN: ${user.familyViewPin ? 'ZAPISANY' : 'BRAK'}
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

  const isAutoOpen = session?.autoOpenEnabled ?? user?.autoOpenEnabled;
  const nextTime = session?.nextCaseTime || user?.nextCaseTime;

  if (!isAutoOpen) {
    ctx.reply('AutoOpen jest wyłączony. Użyj /autoopen, aby uruchomić harmonogram.');
    return;
  }

  let statusText = 'AutoOpen jest aktywny.\n\n';
  statusText += 'Tryb: automatyczny harmonogram w tle\n';
  statusText += 'Automatyczne otwieranie: włączone\n';
  statusText += 'Harmonogram działa przez całą dobę.\n';

  if (nextTime && nextTime > Date.now()) {
    const remainingMs = nextTime - Date.now();
    const timeFormatted = formatTimeMs(remainingMs);
    const minutesLeft = Math.ceil(remainingMs / 60000);
    const targetDate = new Date(nextTime).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });

    const reason=session?.scheduleReason||user?.scheduleReason;
    statusText += `\n⏰ Do następnego ${reason==='cooldown'?'otwarcia':'sprawdzenia'}: ${timeFormatted} (~${minutesLeft} min)\n`;
    statusText += `${reason==='cooldown'?'Planowane automatyczne otwarcie':'Ponowne sprawdzenie statusu'} (czas polski): godz. ${targetDate}`;
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
  logger.info(`🔐 [${userId}] Family View PIN zapisany`);
  ctx.reply('✅ PIN Family View zapisany bezpiecznie!');
});

bot.hears(/^(?!\/|PIN:)([^:]+):(.+)$/, async (ctx) => {
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

async function holdBrowserForVerification(userId, browser, page) {
  const session = activeSessions.get(userId) || {};
  session.verificationRequired = true;
  session.browser = browser;
  session.page = page;
  setSessionAndTrack(userId, session);
  if (process.env.BROWSER_NATIVE === 'true' && browser?.isConnected()) await browser.disconnect();
}

bot.command('verify', async ctx => {
  const userId = ctx.from.id.toString();
  try {
    const session = await ensureBrowserOpen(userId, ctx);
    if (!session?.page) return ctx.reply('Brak sesji przeglądarki. Najpierw użyj /login.');
    await session.page.bringToFront();
    await holdBrowserForVerification(userId,session.browser,session.page);
    await ctx.reply('Przeglądarka na serwerze jest gotowa do ręcznej weryfikacji.\nOtwórz panel przez tunel SSH: http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale\nPo zakończeniu weryfikacji użyj /check, a następnie /autoopen.');
  } catch(error) {
    logger.warn(`[${userId}] Ręczna weryfikacja: ${error.message}`);
    await ctx.reply('Nie udało się przygotować przeglądarki. Sprawdź logi serwera.');
  }
});


bot.command('check', checkDailyCase);
bot.command('open', openDailyCase);
bot.command('autoopen', startAutoOpen);
bot.command('stop', stopAutoOpen);

bot.command('setsteam',ctx=>ctx.reply('Wyślij login i hasło Steam w formacie login:hasło. Wiadomość zostanie usunięta po zapisaniu danych.'));

bot.command('lastopen',async ctx=>{
  const attempt=(await loadUser(String(ctx.from.id)))?.lastDailyAttempt;
  if(!attempt)return ctx.reply('Brak zapisanej próby otwarcia w nowej wersji bota.');
  const date=time=>new Date(time).toLocaleString('pl-PL',{timeZone:'Europe/Warsaw'});
  await ctx.reply(`Ostatnia próba Daily Case\nStan: ${attempt.status}\nEtap: ${attempt.phase}\nRozpoczęcie: ${date(attempt.startedAt)}\n`+
    `${attempt.finishedAt?'Zakończenie: '+date(attempt.finishedAt)+'\n':''}`+
    `Wynik: ${attempt.reward||'nagroda niepotwierdzona'}\nKod diagnostyczny: ${attempt.code||'brak'}`);
});

bot.command('diagnose',async ctx=>{
  const userId=String(ctx.from.id),session=activeSessions.get(userId),user=await loadUser(userId);
  let route='brak',state=null;
  if(session?.page && !session.page.isClosed()) {
    try {route=new URL(session.page.url()).pathname;state=await session.page.evaluate(daily.dailyButtonState);}catch{}
  }
  await ctx.reply(`Diagnostyka bota\nMongoDB: ${mongoose.connection.readyState===1?'połączono':'brak połączenia'}\n`+
    `Operacja: ${operations.busy(userId)||'bezczynny'}\nPrzeglądarka: ${session?.browser?.isConnected()?'połączona':'uśpiona/odłączona'}\n`+
    `Ścieżka strony: ${route}\nPrzycisk: ${state?(state.loading?'przetwarzanie':state.blocked?'zablokowany':state.actionable?'dostępny':'wymagane logowanie/warunki'):'brak gotowego przycisku'}\n`+
    `Podgląd: ${session?.previewUntil>Date.now()?'włączony':'wyłączony'}\n`+
    `AutoOpen: ${(session?.autoOpenEnabled??user?.autoOpenEnabled)?'włączony':'wyłączony'}\n`+
    `Rodzaj terminu: ${session?.scheduleReason||user?.scheduleReason||'brak'}\n`+
    `Ostatnia próba: ${user?.lastDailyAttempt?.status||'brak'} / ${user?.lastDailyAttempt?.code||'brak kodu'}`);
});

bot.command('reconcile',async ctx=>{
  const userId=String(ctx.from.id),attempt=(await User.findOne({telegramId:userId}))?.lastDailyAttempt;
  if(attempt?.status!=='pending')return ctx.reply('Brak niepotwierdzonej próby. Ostatni wynik: /lastopen.');
  const session=await ensureBrowserOpen(userId,ctx);
  if(!session?.page)return ctx.reply('Brak aktywnej sesji. Użyj /login.');
  const info=await daily.goToDaily(session.page,{refresh:true});
  const result=await reconcileAttempt(userId,session.page,attempt,info);
  await ctx.reply(result.success?daily.formatOpened(result.reward,Date.now()+(result.newCooldownMs||300000),result.cooldownKnown):result.error);
});

bot.command('retryopen',async ctx=>{
  const userId=String(ctx.from.id),attempt=(await User.findOne({telegramId:userId}))?.lastDailyAttempt;
  if(attempt?.status!=='pending')return ctx.reply('Brak niepotwierdzonej próby do odblokowania. Użyj /check.');
  if(!/\s+potwierdzam\s*$/i.test(ctx.message.text))return ctx.reply('Najpierw sprawdź historię Daily Case na stronie lub użyj /reconcile. Jeśli ostatnia próba nie otworzyła skrzynki, wyślij /retryopen potwierdzam. Polecenie odblokuje kolejną próbę bez klikania przycisku.');
  await saveAttempt(userId,{...attempt,status:'released',phase:'user-released',finishedAt:Date.now()});
  await ctx.reply('Odblokowano kolejną próbę. Użyj /open lub /autoopen.');
});

bot.command('preview',async ctx=>{
  const userId=String(ctx.from.id);
  if(/\s+off\s*$/i.test(ctx.message.text)) {
    const session=activeSessions.get(userId);if(session)session.previewUntil=0;
    return ctx.reply('Podgląd wyłączony. Przeglądarka może ponownie usypiać po zadaniu.');
  }
  const session=await ensureBrowserOpen(userId,ctx);
  if(!session?.page)return ctx.reply('Brak sesji przeglądarki. Użyj /login.');
  session.previewUntil=Date.now()+30*60000;
  await session.page.bringToFront();
  await ctx.reply('Podgląd włączony na 30 minut. Okno pozostanie otwarte po /autoopen.\nPanel przez tunel SSH: http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale\nWyłączenie: /preview off.');
});

bot.command('close', async (ctx) => {
  const userId = ctx.from.id.toString();
  await browserSession.closeNative(userId);
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
  operations.cancel(userId);
  await persistSchedule(userId,{autoOpenEnabled:false,nextCaseTime:null,scheduleReason:null});
  await Session.deleteOne({telegramId:userId});
  await browserSession.closeNative(userId, true);
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
  const admins=(process.env.BOT_ADMIN_IDS||process.env.TELEGRAM_CHAT_ID||'').split(',').map(x=>x.trim()).filter(x=>/^\d+$/.test(x));
  if(!admins.includes(String(ctx.from.id)))return ctx.reply('Polecenie dostępne wyłącznie dla administratora bota.');
  if(maintenance || operations.active.size)return ctx.reply('Trwa operacja przeglądarki. Reset można wykonać po jej zakończeniu.');
  maintenance=true;
  try {
  await browserSession.closeAll(true);
  logger.info('🔄 [RESETALL] Rozpoczynam reset wszystkich sesji...');

  let closedCount = 0;
  for (const [userId, session] of activeSessions.entries()) {
    operations.cancel(userId);
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
  }finally{maintenance=false;}
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
  const isAutoOpen = session?.autoOpenEnabled ?? user?.autoOpenEnabled;
  const nextTime = session?.nextCaseTime || user?.nextCaseTime;

  let autoOpenStr = '❌ Wyłączony';
  if (isAutoOpen) {
    if (nextTime && nextTime > Date.now()) {
      const mins = Math.ceil((nextTime - Date.now()) / 60000);
      const targetTimeStr = new Date(nextTime).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });
      autoOpenStr = `✅ Włączony (${(session?.scheduleReason||user?.scheduleReason)==='cooldown'?'otwarcie':'sprawdzenie'} o ${targetTimeStr}, za ~${mins} min)`;
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

  await bot.telegram.setMyCommands(commands.map(({command,...entry})=>({...entry,command:command.replace(/^\//,'')}))).catch(error=>logger.warn('Nie udało się ustawić menu Telegram: '+error.message));
  await bot.telegram.setChatMenuButton({
    menu_button: {
      type: 'commands',
      text: 'Menu'
    }
  }).catch(() => {});

  logger.info('🤖 MongoDB połączony - uruchamiam bota Telegram...');

  try {
    // Long polling resolves launch() only after the bot stops. Restore scheduled
    // work in its readiness callback so restarts do not leave AutoOpen dormant.
    await bot.launch({}, () => {
    logger.info('✅ Bot uruchomiony pomyślnie!');
    logger.info('🎯 Bot gotowy do pracy - wyślij /start w Telegramie');

    // Uruchom Watchdog i przywróć zadania AutoOpen z MongoDB
    startAutoOpenWatchdog();
    restoreAutoOpenTasks().catch(error => logger.error('Błąd przywracania AutoOpen:', error.message));

    if (!isProduction) {
      const ConsoleCommands = require('./console-commands');
      const consoleCmd = new ConsoleCommands(
        bot,
        activeSessions,
        loadUser,
        (ctx,method)=>operations.run(String(ctx.from.id),'login',()=>loginToSteam(ctx,method),()=>ctx.reply('Trwa inna operacja.')),
        ctx=>operations.run(String(ctx.from.id),'check',()=>checkDailyCase(ctx),()=>ctx.reply('Trwa inna operacja.')),
        ctx=>operations.run(String(ctx.from.id),'open',()=>openDailyCase(ctx),()=>ctx.reply('Trwa inna operacja.'))
      );

      setTimeout(() => {
        consoleCmd.start();
      }, 500);
    }
    });
  } catch (err) {
    logger.error('❌ Błąd uruchamiania bota:', err);
    process.exit(1);
  }
}

bot.catch(async(error,ctx)=>{
  logger.error(`[${ctx.from?.id||'?'}] Błąd obsługi polecenia: ${error.message}`);
  await ctx.reply('Operacja nie powiodła się. Użyj /diagnose i sprawdź logi serwera.').catch(()=>{});
});

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
  await browserSession.closeAll();
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
  await browserSession.closeAll();
  bot.stop('SIGTERM');
  process.exit(0);
});
