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

Bot czeka na zakończenie hydratacji Nuxt/Vue i podłączenie obsługi kliknięcia do widocznego przycisku. Odróżnia otwieranie od przycisku logowania, linku do wymagań oraz trwającej animacji. Przed kliknięciem sprawdza, czy przycisku nie zasłania popup. Nie klika elementu przez zasłaniające okno.

Otwarcie Daily Case na aktualnej stronie używa Socket.IO (`@User/WheelBonus->Claim`). Bot podłącza pasywny obserwator CDP **przed jednym zwykłym kliknięciem** i czeka do 25 sekund na odpowiedź o zgodnym identyfikatorze żądania i połączenia. Nie wysyła własnych żądań otwarcia. Następnie czeka do 30 sekund na zakończenie animacji i odczyt licznika; nie opuszcza strony po arbitralnych 5 sekundach. Nagrody EXP i skrzynki dodatkowo odczytuje z pierwszego wiersza historii w osobnej karcie, porównując wpis sprzed próby. Skiny mogą być potwierdzane także przez różnicę ekwipunku. Stan MongoDB zapisywany przed kliknięciem chroni przed ponawianiem niepotwierdzonego otwarcia również po restarcie.

AutoOpen podaje godzinę następnego otwarcia w strefie `Europe/Warsaw`. Po otwarciu wysyła jedną wiadomość z nagrodą i kolejnym terminem. Jeśli otwarcie nie zostało potwierdzone, nie zgłasza sukcesu. Przy weryfikacji dostępu zachowuje okno i planuje kolejne sprawdzenie za 30 minut.

Komendy zmieniające kartę, logowanie, wylogowanie i harmonogram korzystają ze wspólnej blokady dla użytkownika. `/stop` pozostaje dostępne podczas operacji: unieważnia trwający cykl, zapobiega kolejnemu kliknięciu, jeśli jeszcze nie nastąpiło, i blokuje ponowne uruchomienie harmonogramu przez kończące się zadanie. Już wysłanego kliknięcia nie można cofnąć. `/checkstatus` odróżnia termin otwarcia od terminu ponownego sprawdzenia błędu.

## Diagnostyka i zarządzanie

| Komenda | Działanie |
| --- | --- |
| `/diagnose` | Stan połączenia, aktywna operacja, ścieżka strony, gotowość przycisku i kod ostatniej próby. Nie przeładowuje strony. |
| `/lastopen` | Zapisany etap, czas, wynik i kod ostatniej próby. Kody `DAILY_NO_REQUEST_OBSERVED`, `DAILY_ACK_TIMEOUT` i `DAILY_CLAIM_REJECTED` odróżniają brak zaobserwowanego żądania, brak odpowiedzi i odmowę serwera. |
| `/reconcile` | Sprawdza historię oraz licznik poprzedniej niepotwierdzonej próby; nie klika otwarcia. |
| `/retryopen potwierdzam` | Po ręcznym sprawdzeniu historii zwalnia blokadę niepotwierdzonej próby. Samo polecenie nie otwiera skrzynki; następnie użyj `/open` lub `/autoopen`. |
| `/preview` | Pozostawia okno otwarte przez 30 minut również po AutoOpen. Panel noVNC wymaga istniejącego tunelu SSH. |
| `/preview off` | Przywraca usypianie okna po zadaniu. |

`/resetall` wymaga identyfikatora administratora w `BOT_ADMIN_IDS` (lista rozdzielona przecinkami), a przy jego braku korzysta z `TELEGRAM_CHAT_ID`. Bez skonfigurowanego administratora polecenie jest niedostępne. Reset jest odrzucany, gdy trwa operacja przeglądarki. Nowe komendy nie publikują cookies, haseł ani PIN-u. PIN jest również maskowany w `/dbtest` i konsoli. Menu Telegram otrzymuje nazwy bez prefiksu `/`, zgodnie z wymaganiami API.

### Konfiguracja odnowienia weryfikacji

`CF_AUTO_RECOVERY=true` włącza lokalną próbę automatycznego odnowienia. Ustaw `false`, aby korzystać wyłącznie z ręcznej weryfikacji. `CF_RECOVERY_TIMEOUT_MS=90000` określa limit czasu w milisekundach; dopuszczalny zakres to 1000–180000. Zmienne są przekazywane przez `docker-compose.override.yml`. Po zmianie `.env` odtwórz usługę `bot` poleceniem `docker compose up -d --no-deps bot`.

Zależność `puppeteer-core` jest przypięta aliasem npm do `rebrowser-puppeteer-core@24.8.1`, zgodnego z używanym Node.js 18. Nie wymaga to pobierania innej przeglądarki — nadal używany jest systemowy Chromium ARM64. Kod wykorzystuje klienta CDP ramki z tej przypiętej wersji wyłącznie do znalezienia pola weryfikacji Cloudflare. Przy aktualizacji sterownika uruchom test zamkniętego Shadow DOM.

Po restarcie zadania AutoOpen i watchdog są przywracane w callbacku gotowości Telegrama. Nie czekają na zakończenie `bot.launch()`, ponieważ przy long pollingu następuje ono dopiero po zatrzymaniu bota.

## Testy

Testy korzystają z Node.js, Chromium i ekranu wirtualnego dostępnych w kontenerze. Wykorzystują syntetyczny HTML; nie otwierają prawdziwej skrzynki ani nie wysyłają wiadomości Telegram.

```bash
docker compose exec bot node --test tests/*.test.cjs
```

Testy obejmują także rzeczywisty Chromium z lokalnym serwerem WebSocket i odpowiedzią opóźnioną o ponad 6 sekund, niedokończoną hydratację, zasłonięty przycisk, korelację odpowiedzi, trwałą blokadę niepewnej próby, izolację operacji użytkowników, zatrzymanie harmonogramu oraz unikalność komend. Testy nie zastępują potwierdzenia najbliższego prawdziwego otwarcia na koncie.
