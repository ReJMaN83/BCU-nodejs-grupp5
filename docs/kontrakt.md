# Datakontrakt

## Block-format

<!-- JSON-struktur för ett block: fält, typer, exempel. -->

## Roller

**Beslutat 2026-09-16.** Samma rollnamn används överallt: databas, JWT, API-svar,
block i kedjan och klienten. Inga engelska varianter (`doctor`, `nurse`).

| Roll | Betydelse |
|---|---|
| `lakare` | Läkare |
| `sjukskoterska` | Sjuksköterska |
| `vardcentral` | Vårdcentralspersonal |
| `patient` | Patient, ser bara sin egen journal |
| `obehorig` | Inloggad utan behörighet till journaler |

Vad varje roll får göra beskrivs i `docs/behorighet.md` (#19).

## API-endpoints

### Auth

**Beslutat 2026-09-16.** Sökvägarna följer klienten (#14, PR #58).

| Metod | Path | Beskrivning |
|---|---|---|
| `POST` | `/api/auth/login` | Loggar in, sätter JWT i en httpOnly-cookie |
| `GET` | `/api/auth/me` | Returnerar inloggad användare utifrån cookien |
| `POST` | `/api/auth/logout` | Rensar cookien |

- Klienten skickar alla anrop med `credentials: 'include'`. Servern svarar med
  CORS för `CLIENT_ORIGIN` och `credentials: true`.
- `401` = inte inloggad eller fel inloggningsuppgifter → klienten visar login.
  `403` = inloggad men saknar behörighet → klienten visar access denied.

<!-- Request/response-payloads för auth fylls i med #6. Klienten förväntar sig
     i dag { id, role, displayName, linkedPatientId } från login och me. -->

## Socket-events

<!-- Eventnamn, riktning (server/klient/peer), payload. -->
