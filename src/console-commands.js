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
      // Nie zamykaj procesu - bot nadal działa
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
        // Sprawdź czy to komenda bota (zaczyna się od /)
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
      // Mapowanie komend na funkcje
      switch (command) {
        case '/start':
          await ctx.reply('👋 Witaj! Bot G4Skins Daily Case.\n\n' +
            'Dostępne komendy:\n' +
            '/setsteam - zapisz dane Steam\n' +
            '/login - zaloguj się\n' +
            '/check - sprawdź daily case\n' +
            '/open - otwórz daily case\n' +
            '/autoopen - włącz/wyłącz automatyczne otwieranie\n' +
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
          // Sprawdź czy użytkownik ma zapisane dane
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
              `- PIN: ${userData.pin ? '✅' : '❌'}`);
          } else {
            await ctx.reply('❌ Brak zapisanych danych');
          }
          break;

        default:
          await ctx.reply(`❌ Nieznana komenda: ${command}`);
      }

      const messages = ctx.getMessages();
      console.log(`✅ Komenda wykonana, wysłano ${messages.length} wiadomości\n`);

    } catch (error) {
      console.error('\x1b[31m%s\x1b[0m', `❌ Błąd wykonania: ${error.message}`);
      logger.error(`Console simulation error for ${userId}:`, error);
    }
  }

  /**
   * Pokazuje pomoc
   */
  showHelp() {
    console.log('\n\x1b[36m%s\x1b[0m', '=== POMOC ===');
    console.log('\nKomendy systemowe:');
    console.log('  setuser <userId>  - Ustaw domyślny userId (np. setuser 961312609)');
    console.log('  user              - Pokaż info o użytkowniku');
    console.log('  sessions          - Lista aktywnych sesji');
    console.log('  log [n]           - Ostatnie n wiadomości');
    console.log('  clear             - Wyczyść log');
    console.log('  exit              - Wyjdź');

    console.log('\nKomendy bota (wymagają userId):');
    console.log('  /check [userId]   - Sprawdź daily case');
    console.log('  /open [userId]    - Otwórz daily case');
    console.log('  /login [userId]   - Zaloguj użytkownika');
    console.log('  /sessions [userId]- Status sesji');
    console.log('  /user [userId]    - Dane użytkownika');

    console.log('\nPrzykłady:');
    console.log('  setuser 961312609');
    console.log('  /check            (użyje domyślnego userId)');
    console.log('  /open 961312609   (użyje podanego userId)');
    console.log('  simulate 961312609 /check');
    console.log('');
  }

  /**
   * Pokazuje informacje o aktualnym użytkowniku
   */
  async showUserInfo() {
    if (!this.defaultUserId) {
      console.log('❌ Brak ustawionego domyślnego userId. Użyj: setuser <userId>');
      return;
    }

    console.log(`\n👤 Informacje o użytkowniku: ${this.defaultUserId}`);

    const user = await this.loadUser(this.defaultUserId);
    if (user) {
      console.log('  Steam Username:', user.steamUsername ? '✅ Zapisany' : '❌ Brak');
      console.log('  Steam Password:', user.steamPassword ? '✅ Zapisany' : '❌ Brak');
      console.log('  PIN:', user.pin ? '✅ Zapisany' : '❌ Brak');
    } else {
      console.log('  ❌ Brak zapisanych danych');
    }

    const session = this.activeSessions.get(this.defaultUserId);
    if (session) {
      console.log('\n  📱 Aktywna sesja:');
      console.log('    Zalogowany:', session.isLoggedIn ? '✅ TAK' : '❌ NIE');
      console.log('    Przeglądarka:', session.browser?.isConnected() ? '✅ Aktywna' : '❌ Nieaktywna');
      console.log('    AutoOpen:', session.autoOpenEnabled ? '✅ Włączony' : '❌ Wyłączony');
    } else {
      console.log('\n  ❌ Brak aktywnej sesji');
    }
    console.log('');
  }

  /**
   * Pokazuje aktywne sesje
   */
  showSessions() {
    console.log(`\n📱 Aktywne sesje: ${this.activeSessions.size}`);

    if (this.activeSessions.size === 0) {
      console.log('  (brak aktywnych sesji)');
    } else {
      for (const [userId, session] of this.activeSessions.entries()) {
        console.log(`\n  User ${userId}:`);
        console.log(`    Zalogowany: ${session.isLoggedIn ? '✅' : '❌'}`);
        console.log(`    Przeglądarka: ${session.browser?.isConnected() ? '✅ Aktywna' : '❌ Nieaktywna'}`);
        console.log(`    AutoOpen: ${session.autoOpenEnabled ? '✅' : '❌'}`);
      }
    }
    console.log('');
  }

  /**
   * Pokazuje log wiadomości
   */
  showLog(count = 10) {
    const recent = this.messageLog.slice(-count);

    console.log(`\n📝 Ostatnie ${recent.length} wiadomości:\n`);

    if (recent.length === 0) {
      console.log('  (brak wiadomości)');
    } else {
      recent.forEach(msg => {
        const time = msg.timestamp.toLocaleTimeString();
        const color = msg.type === 'user' ? '\x1b[33m' : '\x1b[32m';
        const prefix = msg.type === 'user' ? 'USER' : 'BOT';
        console.log(`${color}[${time}] [${msg.userId}] ${prefix}: ${msg.text}\x1b[0m`);
      });
    }
    console.log('');
  }
}

module.exports = ConsoleCommands;
