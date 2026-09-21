# Datakontrakt

Gemensamt kontrakt mellan backend, frontend och blockkedjan. Ändringar görs via PR
som alla i gruppen granskar.

## Beslut: datadelning mellan servrar

**Beslutat 2026-09-16 (#55).** Alla fyra i gruppen godkänner genom att approva PR #65.

a. **Delad databas.** Båda servrarna på samma dator använder samma SQLite-fil i
   WAL-läge (`PRAGMA journal_mode = WAL`). Användare, patienter och anteckningar
   finns alltså på ett ställe.

b. **En kedja per server.** Varje server har sin egen blockkedja, och varje block
   innehåller serverns `nodeId`. Nya block skickas till peern (`block:new`), som
   validerar och sparar en kopia av den andra nodens kedja.

c. **Journaltext aldrig i kedjan.** Anteckningarnas innehåll lagras i databasen och
   skickas till klienter via socket (`note:created`), men lagras ALDRIG i ett block.
   Kedjan innehåller bara vem som läst eller skrivit i vilken journal och när.

d. **Accessloggen är alla kedjor sammanslagna.** Accessloggvyn byggs av alla kända
   noders kedjor, sammanslagna och sorterade på `timestamp`.

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

I avsnitten nedan betyder **personal** rollerna `lakare`, `sjukskoterska` och
`vardcentral`. Detaljerna om vad varje roll får göra finns i `docs/behorighet.md` (#19).
Om den och kontraktet säger olika saker gäller `behorighet.md`.

## Block-format

Ett block i kedjan. Alla tider är ISO 8601 i UTC.

```json
{
  "index": 42,
  "timestamp": "2026-09-18T09:15:02.123Z",
  "nodeId": "node-3001",
  "prevHash": "9f2c1a…e41b",
  "hash": "a71d0c…5f09",
  "data": {
    "userId": 1,
    "role": "lakare",
    "patientId": 1,
    "action": "read",
    "signature": "t4kP…Dg==",
    "publicKey": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n"
  }
}
```

| Fält | Typ | Beskrivning |
|---|---|---|
| `index` | heltal | Position i kedjan, genesis = `0` |
| `timestamp` | sträng | När blocket skapades |
| `nodeId` | sträng | Servern som skapade blocket (`NODE_ID` i env) |
| `prevHash` | sträng | `hash` för föregående block, genesis = `"0"` |
| `hash` | sträng | SHA-256 (hex) av `index + timestamp + nodeId + prevHash + JSON.stringify(data)` |
| `data` | objekt | Ett accessEvent, se nedan. Genesis har `data: null` |

**accessEvent (`data`)**

| Fält | Typ | Beskrivning |
|---|---|---|
| `userId` | heltal | Användaren som gjorde åtkomsten |
| `role` | sträng | Användarens roll vid åtkomsten |
| `patientId` | heltal | Journalen som lästes eller skrevs i |
| `action` | `"read"` \| `"write"` | Läsning eller ny anteckning |
| `signature` | sträng | Ed25519-signatur i base64 med användarens privata nyckel, se nedan |
| `publicKey` | sträng | Användarens publika Ed25519-nyckel (PEM, SPKI) för verifiering |

**Signering: beslutat 2026-09-16.** Algoritmen är Ed25519 via `node:crypto`. Det som
signeras är `JSON.stringify({ userId, role, patientId, action, timestamp })` med
fälten i exakt den ordningen, där `timestamp` är blockets.

```js
import { generateKeyPairSync, sign, verify } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const payload = Buffer.from(JSON.stringify({ userId, role, patientId, action, timestamp }));
const signature = sign(null, payload, privateKey).toString('base64');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

verify(null, payload, publicKeyPem, Buffer.from(signature, 'base64')); // true
```

Med Ed25519 ska algoritmargumentet vara `null`.

> **Ingen journaltext får ligga i `data`.** Inga anteckningar, diagnoser, namn eller
> personnummer. Bara id, roll och typ av åtkomst.

**När skapas block**

- `GET /api/patients/:id` skapar ett `read`-block.
- `POST /api/patients/:id/notes` skapar ett `write`-block.
- Sökning, `GET …/notes` och `GET …/access-log` skapar inga block.

## API-endpoints

Gemensamt för alla anrop:

- Bas-URL: `VITE_API_URL` i klienten, t.ex. `http://localhost:3001`.
- JSON in och ut (`Content-Type: application/json`).
- Klienten skickar alla anrop med `credentials: 'include'`, och servern svarar med
  CORS för `CLIENT_ORIGIN` och `credentials: true`.
- Inloggning sker med JWT i en httpOnly-cookie som servern sätter.
- Fel returneras som `{ "message": "…" }` med statuskod:

| Status | Betydelse | Klienten gör |
|---|---|---|
| `400` | Felaktig request, t.ex. saknat fält | Visar `message` |
| `401` | Inte inloggad, eller fel inloggningsuppgifter | Visar login |
| `403` | Inloggad men saknar behörighet | Visar access denied |
| `404` | Finns inte | Visar "hittades inte" |

### Auth

**Beslutat 2026-09-16.** Sökvägarna följer klienten (`client/src/context/AuthContext.jsx`, PR #58).

#### `POST /api/auth/login`

Auth: ingen.

```json
// request
{ "username": "lakare1", "password": "demo1234" }

// 200, sätter cookie
{ "id": 1, "role": "lakare", "displayName": "Dr. Lindberg", "linkedPatientId": null }
```

Fel: `400` om fält saknas, `401` vid fel användarnamn eller lösenord.

#### `GET /api/auth/me`

Auth: cookie.

```json
// 200
{ "id": 4, "role": "patient", "displayName": "Anna Karlsson", "linkedPatientId": 1 }
```

Fel: `401` om cookie saknas eller är ogiltig. `linkedPatientId` är satt bara för rollen `patient`.

#### `POST /api/auth/logout`

Auth: ingen (rensar cookien om den finns). Request-body behövs inte.

```
// 204 No Content
```

### Patienter

#### `GET /api/patients?search=<text>`

Auth: personal. `patient` och `obehorig` får `403`.

Söker på namn och personnummer (delsträng, skiftlägesokänsligt). Utan `search`
returneras alla patienter.

```json
// 200
[
  { "id": 1, "fullName": "Anna Karlsson", "personalId": "19850312-4521" },
  { "id": 2, "fullName": "Erik Johansson", "personalId": "19921107-8834" }
]
```

#### `GET /api/patients/:id`

Auth: personal, eller `patient` om `id` är hens `linkedPatientId`. Andra får `403`.

Returnerar patienten med anteckningar, och det här är anropet patientvyn använder.
Skapar ett `read`-block.

**Beslutat 2026-09-16.** Synlighetsvärdena följer klienten (PR #61). Servern
filtrerar `notes` efter den inloggades roll innan svaret skickas, så klienten får
aldrig anteckningar den inte får se:

| `visibility` | Syns för |
|---|---|
| `private` | Bara författaren |
| `staff` | All personal |
| `everyone` | All personal och patienten själv |

`notes` sorteras med den nyaste först.

```json
// 200
{
  "id": 1,
  "fullName": "Anna Karlsson",
  "personalId": "19850312-4521",
  "notes": [
    {
      "id": 11,
      "patientId": 1,
      "authorId": 1,
      "authorName": "Dr. Lindberg",
      "authorRole": "lakare",
      "text": "Patient reports improved mobility after physical therapy. Follow-up in 3 weeks.",
      "visibility": "everyone",
      "createdAt": "2026-09-12T12:32:00.000Z"
    }
  ]
}
```

Fel: `404` om patienten inte finns.

#### `GET /api/patients/:id/notes` (valfri)

> **Används inte av patientvyn.** Patientvyn får anteckningarna via
> `GET /api/patients/:id`. Den här endpointen behöver inte finnas för v38. Den är
> till för att hämta om bara anteckningarna utan att skapa ett nytt `read`-block.

Auth: samma som `GET /api/patients/:id`.

Svaret är samma array, med samma filtrering och sortering, som `notes` i
`GET /api/patients/:id`.

```json
// 200
[
  {
    "id": 11,
    "patientId": 1,
    "authorId": 1,
    "authorName": "Dr. Lindberg",
    "authorRole": "lakare",
    "text": "Patient reports improved mobility after physical therapy. Follow-up in 3 weeks.",
    "visibility": "everyone",
    "createdAt": "2026-09-12T12:32:00.000Z"
  }
]
```

#### `POST /api/patients/:id/notes`

Auth: personal. `patient` och `obehorig` får `403`.

Skapar ett `write`-block och skickar `note:created` (se Socket-events).

```json
// request
{ "text": "Blodtryck och vitalparametrar normala.", "visibility": "staff" }

// 201
{
  "id": 14,
  "patientId": 1,
  "authorId": 2,
  "authorName": "Nurse Åström",
  "authorRole": "sjukskoterska",
  "text": "Blodtryck och vitalparametrar normala.",
  "visibility": "staff",
  "createdAt": "2026-09-18T09:20:00.000Z"
}
```

Fel: `400` om `text` är tom eller `visibility` inte är `private`, `staff` eller `everyone`.
`404` om patienten inte finns.

#### `GET /api/patients/:id/access-log`

Auth: samma som `GET /api/patients/:id`.

Byggs av alla kända noders kedjor, filtreras på `patientId` och sorteras på
`timestamp`, nyaste först (beslut d). Namnet slås upp i databasen utifrån `userId`.
`verified` är `true` om signaturen och kedjan som blocket ligger i är giltiga.

```json
// 200
[
  {
    "id": "node-3001-42",
    "userId": 1,
    "name": "Dr. Lindberg",
    "role": "lakare",
    "action": "read",
    "timestamp": "2026-09-18T09:15:02.123Z",
    "nodeId": "node-3001",
    "verified": true
  }
]
```

`id` är `<nodeId>-<index>` och är unikt över alla noder.

## Socket-events

socket.io används på två sätt:

- **Peer:** varje server ansluter som klient till `PEER_URL`.
- **Webbklient:** klienten ansluter till sin server med cookien och går med i rummet
  `patient:<id>` när en patientvy öppnas. Servern kontrollerar behörighet innan
  klienten får gå med.

| Event | Riktning | När |
|---|---|---|
| `peer:hello` | server → peer | Direkt efter anslutning |
| `block:new` | server → peer | Nytt block har lagts till i egen kedja |
| `chain:request` | server → peer | Vid uppstart, eller när ett block inte går att validera |
| `chain:response` | peer → server | Svar på `chain:request` |
| `note:created` | server → peer, server → webbklient | Ny anteckning har sparats |

#### `peer:hello`

```json
{ "nodeId": "node-3001", "url": "http://192.168.1.10:3001", "chainLength": 43 }
```

#### `block:new`

Mottagaren validerar `prevHash`, `hash` och signaturen innan blocket sparas i sin kopia
av avsändarens kedja.

```json
{
  "nodeId": "node-3001",
  "block": {
    "index": 42,
    "timestamp": "2026-09-18T09:15:02.123Z",
    "nodeId": "node-3001",
    "prevHash": "9f2c1a…e41b",
    "hash": "a71d0c…5f09",
    "data": { "userId": 1, "role": "lakare", "patientId": 1, "action": "read", "signature": "t4kP…Dg==", "publicKey": "-----BEGIN PUBLIC KEY-----\n…" }
  }
}
```

#### `chain:request`

```json
{ "nodeId": "node-3002" }
```

#### `chain:response`

`chain` är avsändarens egen kedja från genesis. Mottagaren validerar hela kedjan
innan den ersätter sin kopia.

```json
{
  "nodeId": "node-3001",
  "chain": [
    { "index": 0, "timestamp": "2026-09-18T08:00:00.000Z", "nodeId": "node-3001", "prevHash": "0", "hash": "…", "data": null },
    { "index": 1, "timestamp": "2026-09-18T08:05:12.000Z", "nodeId": "node-3001", "prevHash": "…", "hash": "…", "data": { "…": "accessEvent" } }
  ]
}
```

#### `note:created`

Innehåller anteckningen, men skickas aldrig in i kedjan (beslut c). Servern som tar emot
eventet från peern skickar det vidare till rummet `patient:<patientId>`. Varje server
skickar bara anteckningen till de klienter i rummet som får se den enligt `visibility`.

```json
{
  "originNodeId": "node-3001",
  "note": {
    "id": 14,
    "patientId": 1,
    "authorId": 2,
    "authorName": "Nurse Åström",
    "authorRole": "sjukskoterska",
    "text": "Blodtryck och vitalparametrar normala.",
    "visibility": "staff",
    "createdAt": "2026-09-18T09:20:00.000Z"
  }
}
```

`originNodeId` gör att peern inte skickar tillbaka eventet till servern det kom ifrån.
