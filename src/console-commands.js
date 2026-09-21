const readline = require('readline');
const logger = require('./logger');

/**
 * System komend konsolowych do testowania bota bez potrzeby wysyłania wiadomości przez Telegram
 */
class ConsoleCommands {
  constructor(bot, activeSessions, loadUser, loginToSteam, checkDailyCase, openDailyCase) {
    this.bot = bot;
    this.activeSessions = activeSessions;
    this.loadUser = loadUser;
    this.loginToSteam = loginToSteam;
    this.checkDailyCase = checkDailyCase;
    this.openDailyCase = openDailyCase;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'bot> '
    });

    this.defaultUserId = null;
    this.messageLog = [];
  }

  /**
   * Tworzy mock context dla symulacji komend
   */
  createMockContext(userId, command, text = '') {
    const messages = [];

    return {
      from: {
        id: parseInt(userId),
        first_name: 'Console',
        last_name: 'Test',
        username: 'console_test'
      },
      chat: {
        id: parseInt(userId),
        type: 'private'
      },
      message: {
        text: text || command,
        date: Math.floor(Date.now() / 1000)
      },
      reply: async (text, extra) => {
        const msg = `[${userId}] BOT: ${text}`;
        console.log('\x1b[32m%s\x1b[0m', msg);
        messages.push(msg);
        this.messageLog.push({ userId, type: 'bot', text, timestamp: new Date() });
        return { message_id: Date.now() };
      },
      replyWithMarkdown: async (text, extra) => {
        const msg = `[${userId}] BOT (MD): ${text}`;
        console.log('\x1b[32m%s\x1b[0m', msg);
        messages.push(msg);
        this.messageLog.push({ userId, type: 'bot', text, timestamp: new Date() });
        return { message_id: Date.now() };
      },
      telegram: {
        sendMessage: async (chatId, text, extra) => {
          const msg = `[${chatId}] BOT: ${text}`;
          console.log('\x1b[32m%s\x1b[0m', msg);
          messages.push(msg);
          this.messageLog.push({ userId: chatId, type: 'bot', text, timestamp: new Date() });
          return { message_id: Date.now() };
        }
      },
      getMessages: () => messages
    };
  }

  /**
   * Uruchamia interaktywną konsolę
   */
  start() {
    console.log('\n\x1b[36m%s\x1b[0m', '='.repeat(60));
    console.log('\x1b[36m%s\x1b[0m', '  Console Commands - System testowania bota');
    console.log('\x1b[36m%s\x1b[0m', '='.repeat(60));
    console.log('\nDostępne komendy:');
    console.log('  help                    - Pokaż pomoc');
    console.log('  setuser <userId>        - Ustaw domyślny userId dla komend');
    console.log('  user                    - Pokaż informacje o aktualnym użytkowniku');
    console.log('  sessions                - Lista aktywnych sesji');
    console.log('  /command [userId]       - Wykonaj komendę bota (np. /check, /login, /open)');
    console.log('  simulate <userId> <cmd> - Symuluj komendę dla użytkownika');
    console.log('  log [n]                 - Pokaż ostatnie n wiadomości (domyślnie 10)');
    console.log('  clear                   - Wyczyść log wiadomości');
    console.log('  exit                    - Wyjdź z konsoli\n');

    this.rl.prompt();

    this.rl.on('line', async (line) => {
      const input = line.trim();

      if (!input) {
        this.rl.prompt();
        return;
      }

      try {
        await this.handleCommand(input);
      } catch (error) {
        console.error('\x1b[31m%s\x1b[0m', `❌ Błąd: ${error.message}`);
        logger.error('Console command error:', error);
      }

      this.rl.prompt();
    });

    this.rl.on('close', () => {
      console.log('\n\x1b[36m%s\x1b[0m', 'Zamykam konsolę testową...');
    });
  }

  /**
   * Obsługa komend
   */
  async handleCommand(input) {
    const parts = input.split(' ');
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case 'help':
        this.showHelp();
        break;

      case 'setuser':
        if (parts[1]) {
          this.defaultUserId = parts[1];
          console.log(`✅ Domyślny userId ustawiony na: ${this.defaultUserId}`);
        } else {
          console.log('❌ Użycie: setuser <userId>');
        }
        break;

      case 'user':
        await this.showUserInfo();
        break;

      case 'sessions':
        this.showSessions();
        break;

      case 'simulate':
        if (parts.length >= 3) {
          const userId = parts[1];
          const command = parts.slice(2).join(' ');
          await this.simulateCommand(userId, command);
        } else {
          console.log('❌ Użycie: simulate <userId> <command>');
        }
        break;

      case 'log':
        const count = parseInt(parts[1]) || 10;
        this.showLog(count);
        break;

      case 'clear':
        this.messageLog = [];
        console.log('✅ Log wiadomości wyczyszczony');
        break;

      case 'exit':
      case 'quit':
        this.rl.close();
        break;

      default:
        if (input.startsWith('/')) {
          const cmdParts = input.split(' ');
          const botCommand = cmdParts[0];
          const userId = cmdParts[1] || this.defaultUserId;

          if (!userId) {
            console.log('❌ Brak userId! Użyj: /command <userId> lub ustaw domyślnego: setuser <userId>');
            return;
          }

          await this.simulateCommand(userId, botCommand);
        } else {
          console.log(`❌ Nieznana komenda: ${cmd}. Wpisz 'help' aby zobaczyć dostępne komendy.`);
        }
    }
  }

  /**
   * Symuluje wykonanie komendy bota
   */
  async simulateCommand(userId, command) {
    console.log(`\n\x1b[33m[${userId}] USER: ${command}\x1b[0m`);
    this.messageLog.push({ userId, type: 'user', text: command, timestamp: new Date() });

    const ctx = this.createMockContext(userId, command);

    try {
      switch (command) {
        case '/start':
          await ctx.reply('👋 Witaj! Bot G4Skins Daily Case.\n\n' +
            'Dostępne komendy:\n' +
            '/setsteam - zapisz dane Steam\n' +
            '/login - zaloguj się\n' +
            '/check - sprawdź daily case\n' +
            '/open - otwórz daily case\n' +
            '/autoopen - włącz automatyczne otwieranie (smart scheduler)\n' +
            '/status - sprawdź status\n' +
            '/logout - wyloguj się');
          break;

        case '/check':
          await this.checkDailyCase(ctx);
          break;

        case '/open':
          await this.openDailyCase(ctx);
          break;

        case '/login':
          const user = await this.loadUser(userId);
          if (user && user.steamUsername && user.steamPassword) {
            await ctx.reply('🔄 Automatyczne logowanie z zapisanych danych...');
            await this.loginToSteam(ctx, 'password');
          } else {
            await ctx.reply('❌ Nie masz zapisanych danych Steam! Użyj /setsteam');
          }
          break;

        case '/sessions':
          const session = this.activeSessions.get(userId);
          if (session) {
            await ctx.reply(`✅ Masz aktywną sesję:\n` +
              `- Zalogowany: ${session.isLoggedIn ? 'TAK' : 'NIE'}\n` +
              `- Przeglądarka: ${session.browser?.isConnected() ? 'Aktywna' : 'Nieaktywna'}\n` +
              `- AutoOpen: ${session.autoOpenEnabled ? 'Włączony' : 'Wyłączony'}`);
          } else {
            await ctx.reply('❌ Brak aktywnej sesji');
          }
          break;

        case '/user':
          const userData = await this.loadUser(userId);
          if (userData) {
            await ctx.reply(`👤 Twoje dane:\n` +
              `- Username: ${userData.steamUsername ? '✅' : '❌'}\n` +
              `- Password: ${userData.steamPassword ? '✅' : '❌'}\n` +
              `- PIN: ${userData.familyViewPin ? '✅' : '❌'}`);
          } else {
            await ctx.reply('❌ Brak zapisanych danych');
          }
          break;

        default:
          await ctx.reply(`❌ Nieznana komenda: ${command}`);
      }
    } catch (error) {
      console.error('\x1b[31m%s\x1b[0m', `❌ Błąd wykonania komendy: ${error.message}`);
      logger.error('Error executing simulated command:', error);
    }
  }

  showHelp() {
    console.log('\n\x1b[36m%s\x1b[0m', 'Dostępne komendy konsolowe:');
    console.log('  help                    - Pokaż tę pomoc');
    console.log('  setuser <userId>        - Ustaw domyślny telegramId dla komend');
    console.log('  user                    - Pokaż dane aktualnie wybranego użytkownika');
    console.log('  sessions                - Pokaż wszystkie aktywne sesje w pamięci');
    console.log('  /check [userId]         - Sprawdź status skrzynki');
    console.log('  /open [userId]          - Otwórz skrzynkę');
    console.log('  /login [userId]         - Zaloguj użytkownika');
    console.log('  log [n]                 - Pokaż ostatnie n wiadomości (domyślnie 10)');
    console.log('  clear                   - Wyczyść historię wiadomości');
    console.log('  exit                    - Wyjdź z konsoli testowej\n');
  }

  async showUserInfo() {
    if (!this.defaultUserId) {
      console.log('❌ Nie ustawiono domyślnego użytkownika! Użyj: setuser <userId>');
      return;
    }

    const user = await this.loadUser(this.defaultUserId);
    if (user) {
      console.log('\n\x1b[36m%s\x1b[0m', `Dane użytkownika ${this.defaultUserId}:`);
      console.log(`  Username: ${user.steamUsername || 'BRAK'}`);
      console.log(`  Password: ${user.steamPassword ? '*** (zapisane)' : 'BRAK'}`);
      console.log(`  PIN:      ${user.familyViewPin || 'BRAK'}`);
      console.log(`  AutoOpen: ${user.autoOpenEnabled ? 'TAK' : 'NIE'}`);
      console.log(`  NextCase: ${user.nextCaseTime ? new Date(user.nextCaseTime).toLocaleString('pl-PL') : 'Brak'}\n`);
    } else {
      console.log(`❌ Użytkownik ${this.defaultUserId} nie istnieje w bazie.`);
    }
  }

  showSessions() {
    console.log('\n\x1b[36m%s\x1b[0m', `Aktywne sesje (${this.activeSessions.size}):`);
    if (this.activeSessions.size === 0) {
      console.log('  Brak aktywnych sesji w pamięci.');
      return;
    }

    for (const [userId, session] of this.activeSessions.entries()) {
      const browserStatus = session.browser?.isConnected() ? 'Aktywna' : 'Uśpiona/Zamknięta';
      console.log(`  [${userId}]:`);
      console.log(`    Zalogowany:   ${session.isLoggedIn ? 'TAK' : 'NIE'}`);
      console.log(`    Przeglądarka: ${browserStatus}`);
      console.log(`    AutoOpen:     ${session.autoOpenEnabled ? 'WŁĄCZONY' : 'WYŁĄCZONY'}`);
    }
    console.log('');
  }

  showLog(count = 10) {
    console.log('\n\x1b[36m%s\x1b[0m', `Ostatnie ${count} wiadomości:`);
    const logs = this.messageLog.slice(-count);
    if (logs.length === 0) {
      console.log('  Brak wiadomości w historii.');
      return;
    }

    for (const log of logs) {
      const time = log.timestamp.toLocaleTimeString();
      const color = log.type === 'bot' ? '\x1b[32m' : '\x1b[33m';
      console.log(`${color}[${time}] [${log.userId}] ${log.type.toUpperCase()}: ${log.text}\x1b[0m`);
    }
    console.log('');
  }
}

module.exports = ConsoleCommands;
