# CLAUDE.md

Instruktioner för Claude Code i det här repot.

## Språk i koden

**Gruppbeslut 2026-09-21.** All kod ska vara på engelska: identifierare, rollnamn,
databasvärden, API-fält, env-namn, filnamn och commit-meddelanden. Det gäller även
UI-texter och felmeddelanden.

Svenska får finnas kvar i:

- kodkommentarer som redan är svenska
- `docs/moten/`
- `gruppkontrakt.md`
- löptexten i `docs/kontrakt.md` och `README.md`

Nya kommentarer får skrivas på svenska, för att matcha den kod som redan finns.

## Rollnamn

`doctor`, `nurse`, `clinic`, `patient`, `unauthorized`. Samma värden i databas, JWT,
API-svar, block i kedjan och klienten. Se `docs/kontrakt.md`.

## Datakontrakt

`docs/kontrakt.md` är källan för API-endpoints, blockformat, socket-events och
behörighetsregler. Ändringar i kontraktet görs via PR som hela gruppen granskar, och
koden ska följa det som står där.

## Arbetssätt

- Main är skyddad och kräver en godkänd review. Arbeta i en branch och öppna PR.
- Använd repots PR-mall (`.github/pull_request_template.md`) och skriv `Closes #<nr>`.
- Vanlig merge, inte squash, eftersom PRs ofta är staplade på varandra.
- Databasen är en delad SQLite-fil i WAL-läge. Seed-data skapas från `docs/database.sql`
  vid start. Byter seed-kontona namn måste alla ta bort sin lokala `data/journal.db`.
- Tester: `cd server && npm test` (vitest). Klienten byggs med `cd client && npm run build`.
