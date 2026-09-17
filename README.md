# BCU-nodejs-grupp5

## Starta servrarna

Servern ligger i `server/` (Express, ES modules). Varje instans läser `PORT`,
`NODE_ID`, `PEER_URL`, `CLIENT_ORIGIN` och `DB_PATH` från en env-fil. Mallen är
`server/.env.example`.

```bash
cd server
npm install
```

### Två servrar på samma dator

Skapa en env-fil per instans från mallen:

```bash
cp .env.example .env.3001
cp .env.example .env.3002
```

Ändra i `.env.3002` till:

```
PORT=3002
NODE_ID=node-3002
PEER_URL=http://localhost:3001
```

Starta sedan i två terminaler:

```bash
npm run dev:3001
npm run dev:3002
```

### En server per dator

```bash
cp .env.example .env    # sätt PORT, NODE_ID och PEER_URL (den andra datorns IP)
npm run dev
```

### Databasen

`DB_PATH` (standard `../data/journal.db`, relativt `server/`) pekar ut SQLite-filen som båda instanserna delar. Finns inte tabellerna skapas de från `docs/database.sql` med seed-data när servern startar. Seed-användarna har lösenordet `demo1234`. Använd ett nytt `DB_PATH` för en separat demo; databas och tillhörande nyckelkatalog ska bevaras tillsammans vid backup/återställning.

### Signerade access-event

Implementationsval under review: serverhanterade Ed25519-nycklar, publik PEM/SPKI
i `users.public_key` och privat PEM/PKCS8 i `<dbFile>.keys/<userId>.pem`.
Kataloger med suffix `.keys` ignoreras av Git. På Unix skapas katalogen med `700`
och nyckelfilen med `600`; lagring som andra användare har rättigheter till avvisas.

Modulen öppnar ingen databas själv. Använd den befintliga anslutningen `db` och
absoluta sökvägen `dbFile` från `server/src/db.js`:

```js
const signing = createAccessSigner(db, `${dbFile}.keys`);
const data = signing.signAccessEvent({ userId, role, patientId, action }, timestamp);
const block = blockchain.addBlock(data, timestamp);
const validSignature = signing.verifyAccessEvent(block.data, block.timestamp);
```

Importera `createAccessSigner` från `server/src/access-signing.js`. Båda servrarna
ska använda samma databasfil och exakt samma nyckelkatalog, oberoende av `NODE_ID`.
Signering startar en egen SQLite-transaktion med `BEGIN IMMEDIATE` och ska anropas
utanför en redan pågående transaktion. En komplett nyckelfil publiceras atomiskt
utan överskrivning. En registrerad nyckel med saknad, korrupt eller felaktig privat
fil ger fel; ingen automatisk rotation görs.

Backend ansvarar för inloggning och journalbehörighet. Använd samma uttryckliga
`timestamp` vid signering och blockskapande. Verifiering använder användarens
registrerade publika nyckel och skapar inga nycklar. Detta är serverhanterad
signering, inte en personlig webbläsarsignatur. `Blockchain.isValid()` kontrollerar
fortfarande bara struktur och hashar. Backendkopplingen kommer i #13.

### Tester

Kör `cd server && npm test`. Signeringstester använder temporära SQLite-filer och
nyckelkataloger, inklusive två separata processer mot samma databas. De importerar
inte `db.js` och öppnar inte den vanliga demodatabasen.

### Kontrollera att de lever

```bash
curl http://localhost:3001/api/health   # {"ok":true,"port":3001,"nodeId":"node-3001","patients":5}
curl http://localhost:3002/api/health   # {"ok":true,"port":3002,"nodeId":"node-3002","patients":5}
```

Frontend ligger i `client/` (se #14).
