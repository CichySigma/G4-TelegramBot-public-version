# Console Commands - System Testowania Bota

System interaktywnych komend konsolowych do testowania bota Telegram bez potrzeby wysyłania rzeczywistych wiadomości.

## Uruchomienie

Gdy uruchomisz bota w trybie deweloperskim (`npm run dev`), automatycznie zostanie uruchomiona konsola komend:

```bash
npm run dev
```

Po uruchomieniu zobaczysz prompt:
```
bot>
```

## Dostępne Komendy

### Komendy Systemowe

#### `help`
Wyświetla listę dostępnych komend z opisem.

```
bot> help
```

#### `setuser <userId>`
Ustawia domyślny userId, który będzie używany dla wszystkich komend bota.

```
bot> setuser 961312609
✅ Domyślny userId ustawiony na: 961312609
```

#### `user`
Wyświetla szczegółowe informacje o aktualnie ustawionym użytkowniku (dane Steam, PIN, status sesji).

```
bot> user
👤 Informacje o użytkowniku: 961312609
  Steam Username: ✅ Zapisany
  Steam Password: ✅ Zapisany
  PIN: ✅ Zapisany

  📱 Aktywna sesja:
    Zalogowany: ✅ TAK
    Przeglądarka: ✅ Aktywna
    AutoOpen: ❌ Wyłączony
```

#### `sessions`
Wyświetla listę wszystkich aktywnych sesji użytkowników.

```
bot> sessions
📱 Aktywne sesje: 1

  User 961312609:
    Zalogowany: ✅
    Przeglądarka: ✅ Aktywna
    AutoOpen: ❌
```

#### `log [n]`
Wyświetla ostatnie n wiadomości z historii (domyślnie 10).

```
bot> log 5
📝 Ostatnie 5 wiadomości:

[16:07:45] [961312609] USER: /check
[16:07:46] [961312609] BOT: 🔄 Sprawdzam daily case...
[16:07:48] [961312609] BOT: ✅ Daily case jest dostępny!
```

#### `clear`
Czyści log wiadomości.

```
bot> clear
✅ Log wiadomości wyczyszczony
```

#### `exit` / `quit`
Zamyka konsolę (bot nadal działa w tle).

```
bot> exit
Zamykam konsolę testową...
```

---

### Komendy Bota

Możesz wykonywać komendy bota na dwa sposoby:

1. **Z domyślnym userId** (wymaga wcześniejszego `setuser`):
   ```
   bot> /check
   ```

2. **Z podanym userId**:
   ```
   bot> /check 961312609
   ```

#### `/check [userId]`
Sprawdza status daily case dla użytkownika.

```
bot> /check
[961312609] USER: /check
[961312609] BOT: 🔄 Sprawdzam daily case...
[961312609] BOT: ✅ Daily case jest dostępny!
✅ Komenda wykonana, wysłano 2 wiadomości
```

#### `/open [userId]`
Otwiera daily case dla użytkownika.

```
bot> /open
[961312609] USER: /open
[961312609] BOT: 📦 Sprawdzam ekwipunek przed otwarciem...
[961312609] BOT: 🎁 Otworzono case! Otrzymano: AK-47 | Redline
✅ Komenda wykonana, wysłano 2 wiadomości
```

#### `/login [userId]`
Loguje użytkownika do Steam (wymaga zapisanych danych).

```
bot> /login
[961312609] USER: /login
[961312609] BOT: 🔄 Automatyczne logowanie z zapisanych danych...
[961312609] BOT: ✅ Zalogowano pomyślnie!
✅ Komenda wykonana, wysłano 2 wiadomości
```

#### `/sessions [userId]`
Wyświetla status sesji użytkownika.

```
bot> /sessions
[961312609] USER: /sessions
[961312609] BOT: ✅ Masz aktywną sesję:
- Zalogowany: TAK
- Przeglądarka: Aktywna
- AutoOpen: Wyłączony
✅ Komenda wykonana, wysłano 1 wiadomości
```

#### `/user [userId]`
Wyświetla zapisane dane użytkownika.

```
bot> /user
[961312609] USER: /user
[961312609] BOT: 👤 Twoje dane:
- Username: ✅
- Password: ✅
- PIN: ✅
✅ Komenda wykonana, wysłano 1 wiadomości
```

#### `/start [userId]`
Wyświetla wiadomość powitalną z listą komend.

```
bot> /start
[961312609] USER: /start
[961312609] BOT: 👋 Witaj! Bot G4Skins Daily Case...
✅ Komenda wykonana, wysłano 1 wiadomości
```

---

### Zaawansowane Komendy

#### `simulate <userId> <command>`
Symuluje wykonanie komendy dla konkretnego użytkownika. Działa tak samo jak `/command [userId]`, ale z bardziej jawną składnią.

```
bot> simulate 961312609 /check
```

---

## Przykładowy Workflow Testowania

### 1. Ustaw domyślnego użytkownika
```
bot> setuser 961312609
```

### 2. Sprawdź dane użytkownika
```
bot> user
```

### 3. Przetestuj logowanie
```
bot> /login
```

### 4. Sprawdź daily case
```
bot> /check
```

### 5. Otwórz daily case
```
bot> /open
```

### 6. Zobacz historię wiadomości
```
bot> log 10
```

### 7. Sprawdź aktywne sesje
```
bot> sessions
```

---

## Kolory w Konsoli

- 🟡 **Żółty** - Wiadomości użytkownika (USER)
- 🟢 **Zielony** - Odpowiedzi bota (BOT)
- 🔴 **Czerwony** - Błędy
- 🔵 **Niebieski** - Informacje systemowe

---

## Uwagi

1. **Tylko tryb deweloperski**: Konsola jest dostępna tylko gdy `isProduction = false`
2. **Bot działa normalnie**: Konsola nie wpływa na normalne działanie bota Telegram - możesz jednocześnie testować przez konsolę i używać bota w Telegramie
3. **Mock context**: Komendy używają symulowanego contextu Telegram - wszystkie odpowiedzi są tylko wyświetlane w konsoli
4. **Sesje są współdzielone**: Jeśli zalogujesz użytkownika przez konsolę, będzie on zalogowany również w prawdziwym bocie Telegram

---

## Debugowanie

### Problem: "Brak userId"
```
❌ Brak userId! Użyj: /command <userId> lub ustaw domyślnego: setuser <userId>
```
**Rozwiązanie**: Ustaw domyślnego użytkownika: `setuser 961312609`

### Problem: "Sesja nie ma wymaganych właściwości"
```
❌ Błąd sesji! Spróbuj zalogować się ponownie /login
```
**Rozwiązanie**: Zaloguj się ponownie używając `/login`

### Problem: "Nie masz zapisanych danych Steam"
```
❌ Nie masz zapisanych danych Steam! Użyj /setsteam
```
**Rozwiązanie**: Musisz najpierw zapisać dane Steam w prawdziwym bocie Telegram używając komendy `/setsteam`

---

## Przykładowe Scenariusze

### Testowanie kompletnego flow
```bash
bot> setuser 961312609
bot> /login
bot> /check
bot> /open
bot> log 10
```

### Testowanie wielu użytkowników
```bash
bot> /check 961312609
bot> /check 123456789
bot> sessions
```

### Debug konkretnego problemu
```bash
bot> setuser 961312609
bot> /check
bot> user
bot> sessions
bot> log
```
