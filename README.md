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

G4Skins może zwrócić ekran weryfikacji i HTTP 403. Bot rozpoznaje ten stan i nie zgłasza go jako brak przycisku ani udane logowanie. Automatyzacja nie rozwiązuje CAPTCHA. Ręczna weryfikacja i późniejsze działanie bota zależą od dostępu przyznanego przez G4Skins.

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

## Testy

Testy korzystają z Node.js, Chromium i ekranu wirtualnego dostępnych w kontenerze. Wykorzystują syntetyczny HTML; nie otwierają prawdziwej skrzynki ani nie wysyłają wiadomości Telegram.

```bash
docker compose exec bot node --test tests/daily-case.test.cjs tests/browser-session.test.cjs
```
