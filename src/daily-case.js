const DAILY_URL = 'https://g4skins.com/daily-case';
const OPEN_URL = `${DAILY_URL}/open`;
const {waitForPageAccess} = require('./access-recovery');

// This function runs in Chromium and is also exercised against HTML fixtures.
function dailyButtonState() {
  const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const candidates = [...document.querySelectorAll('.top-options .G_Button.big.max, .top-options .G_Button.big')];
  const button = candidates.find(visible);
  if (!button) return null;
  const time = (button.querySelector('.button_text') || button).textContent.trim();
  const blocked = button.classList.contains('block') || button.disabled || button.getAttribute('aria-disabled') === 'true';
  return {found:true, blocked:!!blocked, time:blocked ? time : null};
}

function latestHistoryRow() {
  const table = [...document.querySelectorAll('.daily-reward-history-table')].find(el => el.getClientRects().length);
  if (!table) return null;
  const row = table.querySelector('tbody tr');
  if (!row) return {signature:'EMPTY', type:'empty'};
  const cells = row.querySelectorAll('td');
  const weapon = row.querySelector('.item-name-weapon')?.textContent.trim() || '';
  const skin = row.querySelector('.item-name-skin')?.textContent.trim() || '';
  const value = cells[1]?.textContent.trim() || '';
  const date = cells[2]?.textContent.trim() || '';
  const image = row.querySelector('img')?.getAttribute('src') || '';
  const signature = JSON.stringify([weapon,skin,value,date,image]);
  if (/exp/i.test(value) || /experience points/i.test(weapon) || /\/exp\.svg/.test(image)) {
    const amount = value.match(/[\d\s.,]+(?=\s*EXP)/i)?.[0].trim();
    return {type:'exp',amount,value,date,signature};
  }
  const type = /\/cases\//.test(image) || /^(case|skrzynka)$/i.test(skin) ? 'case' : 'skin';
  return {type,name:type === 'case' ? weapon : [weapon,skin].filter(Boolean).join(' | '),value,date,signature};
}

async function waitForDailyButton(page, timeout = 30000) {
  try {
    return await waitForPageAccess(page,dailyButtonState,{timeout});
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    const title = await page.title();
    if (/just a moment|attention required|access denied/i.test(title)) {
      const blocked = new Error('G4Skins wymaga ręcznej weryfikacji dostępu. Użyj /verify i wykonaj weryfikację w przeglądarce serwera przez tunel SSH. Po zakończeniu użyj /check.');
      blocked.code = 'SITE_VERIFICATION';
      throw blocked;
    }
    throw new Error('Przycisk Daily Case nie pojawił się w ciągu 30 sekund. Sprawdź sesję logowania i układ strony.');
  }
}

async function goToDaily(page) {
  if (page.url().split('?')[0] !== OPEN_URL) {
    await page.goto(OPEN_URL,{waitUntil:'domcontentloaded',timeout:30000});
  }
  return waitForDailyButton(page);
}

async function clickDailyButton(page) {
  const state = await waitForDailyButton(page);
  if (state.blocked) return state;
  const buttons = await page.$$('.top-options .G_Button.big.max, .top-options .G_Button.big');
  try {
    for (const button of buttons) {
      const usable = await button.evaluate(el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
      if (!usable) continue;
      const blocked = await button.evaluate(el => el.classList.contains('block') || el.disabled || el.getAttribute('aria-disabled') === 'true');
      if (blocked) return {...state,blocked:true};
      await button.click();
      return {...state,clicked:true};
    }
    throw new Error('Przycisk Daily Case zniknął przed kliknięciem.');
  } finally { await Promise.all(buttons.map(button => button.dispose())); }
}

async function readLatestReward(page) {
  await page.goto(DAILY_URL,{waitUntil:'domcontentloaded',timeout:30000});
  try {
    await waitForPageAccess(page,() => {
      const button = document.querySelectorAll('.G_Button.blue')[0];
      return !!(button && button.getClientRects().length && !button.disabled);
    },{timeout:30000});
  } catch (error) {
    if (/just a moment|attention required|access denied/i.test(await page.title())) {
      throw new Error('Historia nagród jest niedostępna: strona wymaga weryfikacji dostępu.');
    }
    throw error;
  }
  const button = await page.$('.G_Button.blue');
  try { await button.click(); } finally { await button.dispose(); }
  await page.waitForFunction(() => {
    const table = [...document.querySelectorAll('.daily-reward-history-table')].find(el => el.getClientRects().length);
    return !!table?.querySelector('tbody tr');
  },{timeout:15000});
  return page.evaluate(latestHistoryRow);
}

function formatNext(nextTime) {
  return new Date(nextTime).toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Warsaw'});
}

function parseCooldown(text) {
  if (typeof text!=='string') return null;
  const colon=text.match(/(?:^|\s)(\d+)\s*:\s*(\d{2})\s*:\s*(\d{2})(?:$|\s)/);
  if (colon) return (+colon[1]*3600 + +colon[2]*60 + +colon[3])*1000;
  const units=[...text.toLowerCase().matchAll(/(\d+)\s*(godz|h|min|m|sek|s)\b/g)];
  if (!units.length) return null;
  return units.reduce((total,match)=>total + +match[1]*(/^(godz|h)$/.test(match[2])?3600:/^(min|m)$/.test(match[2])?60:1),0)*1000;
}

function formatOpened(reward, nextTime, cooldownKnown = true) {
  const hours = (Math.max(0,nextTime-Date.now())/3600000).toFixed(1);
  return `🎁 Daily Case został otwarty.\nOtrzymałeś: ${reward || 'nie udało się potwierdzić nagrody w historii ani ekwipunku.'}\n` +
    (cooldownKnown ? `⏳ Następny Daily Case za ~${hours}h (godz. ${formatNext(nextTime)}).` :
      `Nie udało się odczytać czasu następnego otwarcia. Ponowne sprawdzenie o godz. ${formatNext(nextTime)}.`);
}

module.exports = {dailyButtonState,latestHistoryRow,waitForDailyButton,goToDaily,clickDailyButton,readLatestReward,formatNext,formatOpened,parseCooldown};
