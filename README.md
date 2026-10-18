# G4Skins Telegram Bot

Bot obsługuje logowanie Steam, sprawdzanie i otwieranie Daily Case oraz harmonogram AutoOpen. Docker instaluje systemowy Chromium dla architektury obrazu, w tym ARM64 używanej na Oracle Ampere. Kod produkcyjny respektuje `PUPPETEER_EXECUTABLE_PATH`.

## Uruchomienie przez Docker Compose

```bash
cp .env.example .env
cp docker-compose.example.yml docker-compose.yml
```

W `.env` ustaw `TELEGRAM_BOT_TOKEN` i `MONGODB_URI`. Opcjonalnie podaj `TELEGRAM_CHAT_ID`. Nie publikuj `.env`, lokalnego `docker-compose.yml`, kluczy SSH ani profili przeglądarki. Jeśli wdrożenie ma już własny `docker-compose.yml`, zachowaj jego konfigurację i upewnij się, że przekazuje wymagane zmienne do usługi `bot`.

```bash
docker compose up -d --build --no-deps bot
docker compose logs -f --tail=100 bot
```

Compose automatycznie dołącza `docker-compose.override.yml`. Uruchamia on przeglądarkę z oknem, zapisuje profile w wolumenie `browser_profiles` i publikuje panel noVNC wyłącznie pod `127.0.0.1:6080`. Skrypt `docker-entrypoint.sh` uruchamia Xvfb, x11vnc, websockify i bota. Dostęp do zewnętrznej bazy MongoDB musi być dozwolony z adresu serwera.

## Ręczna weryfikacja strony

G4Skins może ponownie wymagać weryfikacji również wtedy, gdy zapisane cookie nadal ma przyszłą datę ważności. Bot używa lokalnego, zmodyfikowanego sterownika Puppeteera i przed zgłoszeniem błędu podejmuje ograniczoną próbę odnowienia weryfikacji w tej samej przeglądarce. Obsługuje zarówno oczekiwanie na kontrolę JavaScript, jak i widoczne pole potwierdzenia w ramce `challenges.cloudflare.com`, także wewnątrz zamkniętego Shadow DOM.

Odnowienie wykonuje najwyżej jedno przeładowanie i trzy kliknięcia pola weryfikacji w ciągu domyślnie 90 sekund. Nie używa płatnych usług, zewnętrznych solverów ani proxy. Sukces jest potwierdzany dopiero po pojawieniu się oczekiwanego elementu G4Skins. Rozwiązanie nie gwarantuje obsługi każdego rodzaju challenge ani stałego dostępu, jeśli serwis zmieni zabezpieczenia. Gdy próba się nie powiedzie, można wykonać weryfikację ręczną:

1. Z własnego komputera uruchom tunel SSH, podstawiając ścieżkę do swojego klucza i adres serwera:

   ```bash
   ssh -N -L 127.0.0.1:6080:127.0.0.1:6080 -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -i /path/to/private-key ubuntu@SERVER_IP
   ```

2. Wyślij botowi `/verify`.
3. Otwórz `http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale` na komputerze z tunelem.
4. Wykonaj ręcznie weryfikację i ewentualne logowanie. Następnie wyślij `/check` i `/autoopen`.

Podczas weryfikacji bot odłącza Puppeteera, pozostawiając okno otwarte. Po `/check` podłącza się ponownie do tej samej przeglądarki. Profil jest oddzielny dla każdego użytkownika. Aktualne cookies profilu nie są nadpisywane starszymi danymi z bazy. `/logout` usuwa profil użytkownika. Nie otwieraj portu 6080 publicznie.

Jeśli ręczna weryfikacja również kończy się HTTP 403, skontaktuj się z G4Skins w sprawie dozwolonej automatyzacji lub dopuszczenia adresu serwera. Zmiana trybu przeglądarki nie gwarantuje dostępu. [Obsługiwane środowiska Cloudflare](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/).

## Nagrody i harmonogram

Bot czeka do 30 sekund na widoczny przycisk Daily Case. Nagrody EXP i skrzynki odczytuje z pierwszego wiersza historii po kliknięciu pierwszego przycisku `.G_Button.blue`. Porównuje wpis przed otwarciem i po nim, aby nie przypisać starej nagrody do nowej próby. Skiny nadal wykrywa przez różnicę ekwipunku.

AutoOpen podaje godzinę następnego otwarcia w strefie `Europe/Warsaw`. Po otwarciu wysyła jedną wiadomość z nagrodą i kolejnym terminem. Jeśli otwarcie nie zostało potwierdzone, nie zgłasza sukcesu. Przy weryfikacji dostępu zachowuje okno i planuje kolejne sprawdzenie za 30 minut.

### Konfiguracja odnowienia weryfikacji

`CF_AUTO_RECOVERY=true` włącza lokalną próbę automatycznego odnowienia. Ustaw `false`, aby korzystać wyłącznie z ręcznej weryfikacji. `CF_RECOVERY_TIMEOUT_MS=90000` określa limit czasu w milisekundach; dopuszczalny zakres to 1000–180000. Zmienne są przekazywane przez `docker-compose.override.yml`. Po zmianie `.env` odtwórz usługę `bot` poleceniem `docker compose up -d --no-deps bot`.

Zależność `puppeteer-core` jest przypięta aliasem npm do `rebrowser-puppeteer-core@24.8.1`, zgodnego z używanym Node.js 18. Nie wymaga to pobierania innej przeglądarki — nadal używany jest systemowy Chromium ARM64. Kod wykorzystuje klienta CDP ramki z tej przypiętej wersji wyłącznie do znalezienia pola weryfikacji Cloudflare. Przy aktualizacji sterownika uruchom test zamkniętego Shadow DOM.

Po restarcie zadania AutoOpen i watchdog są przywracane w callbacku gotowości Telegrama. Nie czekają na zakończenie `bot.launch()`, ponieważ przy long pollingu następuje ono dopiero po zatrzymaniu bota.

## Testy

Testy korzystają z Node.js, Chromium i ekranu wirtualnego dostępnych w kontenerze. Wykorzystują syntetyczny HTML; nie otwierają prawdziwej skrzynki ani nie wysyłają wiadomości Telegram.

```bash
docker compose exec bot node --test tests/daily-case.test.cjs tests/browser-session.test.cjs tests/access-recovery.test.cjs tests/startup.test.cjs
```
