# BCU-nodejs-grupp5

## Starta servrarna

Servern ligger i `server/` (Express, ES modules). Varje instans läser `PORT`,
`NODE_ID`, `PEER_URL`, `CLIENT_ORIGIN`, `DB_PATH` och `JWT_SECRET` från en env-fil. Mallen är
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

### P2P-hälsning (#22)

Med två instanser igång enligt ovan ska båda terminalerna visa `peer:hello from`
följt av den andra nodens id, adress och kedjelängd. `PEER_URL` anger den andra
servern. Socket.IO ansluter automatiskt igen om den startar senare eller startas om.
Eftersom båda noderna ansluter kan två hälsningar per nod visas; varje anslutning
skickar en hälsning i vardera riktningen. Inkommande hälsningar utlöser inga svarsslingor.

`NODE_URL` är valfri och anger nodens egen adress i hälsningen (standard
`http://localhost:PORT`). Vid körning på olika datorer ska den sättas till den egna
LAN-adressen och `PEER_URL` till den andra datorns adress. Hälsningen identifierar
noden men autentiserar den inte. Blocköverföring och verifiering hör till #39.
Ctrl+C stänger både inkommande och utgående Socket.IO-anslutningar.

Windows: om `npm ci` försöker bygga better-sqlite3 och ger Python-fel har projektets
låsta paket verifierats med `npm ci --ignore-scripts` i `server/`. Det använder den
medföljande binären; kör sedan `npm test` för att kontrollera installationen.

### En server per dator

```bash
cp .env.example .env    # sätt PORT, NODE_ID och PEER_URL (den andra datorns IP)
npm run dev
```

### Databasen

`DB_PATH` (standard `../data/journal.db`, relativt `server/`) pekar ut SQLite-filen som båda instanserna delar. Finns inte tabellerna skapas de från `docs/database.sql` med seed-data när servern startar. Seed-användarna (`doctor1`, `nurse1`, `clinic1`, `patient1`, `unauthorized1`) har lösenordet `demo1234`. `JWT_SECRET` måste vara samma på båda instanserna, annars godtas inte varandras cookies. Använd ett nytt `DB_PATH` för en separat demo. Stoppa servrarna och bevara databas, tillhörande nyckelkatalog (`<dbFile>.keys`) och kedjekatalog (`<dbFile>.chains`) tillsammans vid backup/återställning; behåll samma `NODE_ID`.

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
fortfarande bara struktur och hashar.

### Access-logg för backend

Den namngivna exporten `chain` finns i `server/src/chain.js`. Från exempelvis
`server/src/middleware/auditLogger.js` kan Daniel anropa:

```js
import { chain } from '../chain.js';

const block = chain.addAccessLog({
  userId: authenticatedUser.id,
  role: authenticatedUser.role,
  patientId,
  action: 'read', // eller 'write'
});
```

Eventet får innehålla endast `userId`, `role`, `patientId` och `action`.
Anropet är synkront: modulen skapar en tidsstämpel, signerar och lägger till ett
block med samma tidsstämpel. Det skapade blocket returneras; ogiltig befintlig
kedja, felaktigt event, användar-/rollkonflikt eller signeringsfel kastar fel utan
att lägga till block. Skicka inte vidare en hel request-body.

Exporten återanvänder samma lokala `Blockchain`, tillgänglig som
`chain.blockchain`, under processens livstid. Den använder `config.nodeId`,
befintlig `db` och `${dbFile}.keys`. För separata instanser eller tester finns
`createAccessLog(nodeId, db, keyDirectory, chainFile)` i `server/src/access-log.js`.
Fjärde argumentet är en explicit filsökväg; utan det arbetar isolerade tester
fortfarande bara i minnet. Kärnmodulen öppnar ingen databas själv.

Backend ansvarar för autentisering, journalbehörighet, verifierad `userId`/`role`,
att `patientId` avser den faktiska journaloperationen och samordning med
journal-/anteckningsskrivningen. Anropa utanför en pågående SQL-transaktion;
annars kastas fel och anroparens transaktion lämnas öppen. Journaldata,
nyckelfiler och kedjan ingår inte i en gemensam atomisk transaktion.

Produktions-exporten återställer den egna kedjan vid start och sparar efter varje
lokalt blocktillägg innan `addAccessLog` returnerar. Vid lagringsfel kastas fel och
just det nya blocket tas bort ur minneskedjan. Signeringens eventuella
nyckelregistrering rullas inte tillbaka. `auditLogger` kan därefter indexera det
returnerade blocket i SQL och skicka det till peers med `block:new` (#39).

### Lokal kedjepersistens (#30)

Hela den lokala kedjan lagras som en JSON-array i
`<dbFile>.chains/<sha256(NODE_ID)>.json`. `chainFilePath(dbFile, nodeId)` i
`server/src/chain-storage.js` beräknar den absoluta sökvägen. SHA-256 av nodnamnet
ger ett filnamn med fast längd utan sökvägsdelar. Två noder som delar databas har
separata filer. För `NODE_ID=node-3001` är filnamnet:

```text
97985c055e5d64ff413f49a7018c711ad74849759efe965421b65c5e3953ad4f.json
```

Vid start läses JSON utan att blocken rekonstrueras. Hela kedjan kontrolleras med
`verifyChain` mot konfigurerad nod och `users.public_key` innan den tilldelas
`chain.blockchain.chain`. Fältordning, tidsstämpeltext och hashar bevaras.
Historiska block kan återställas utan privata nyckelfiler; dessa behövs däremot
för nya signerade block.

Före varje beständigt tillägg verifieras även minneskedjans signaturer, och hela
dess befintliga historik måste motsvara senast lästa/sparade JSON-kedja. Ändrad
eller avkortad minneshistorik ger fel före signering och blocktillägg. Filen och
SQL-indexet lämnas kvar; minneshistoriken repareras inte automatiskt.

Varje befintlig SQL-rad i `access_logs` för den lokala noden måste peka på samma
blockindex och hash i kedjan. Korrupt JSON, ogiltig kedja, SQL-avvikelse eller
saknad kedjefil trots lokal SQL-historik ger startfel. Filen repareras eller
skrivs inte över. Saknas både fil och lokal SQL-historik börjar noden med genesis;
filen skapas vid första lyckade blocktillägget. En kedja som ligger före SQL-indexet
godtas, men saknade indexrader byggs inte upp automatiskt.

**Efter uppgradering till #30:** en databas där servern redan loggat läsningar utan
kedjefil ger startfelet `Cannot restore local chain: missing file with existing SQL
access history`. Ta bort `data/journal.db*` (inklusive `.keys` och `.chains`) så
skapas en ny databas med seed-data vid start.

Lagring skriver en komplett temporär fil i samma katalog, synkar filinnehållet
och publicerar med atomisk `rename`. Nya kataloger/filer får rättigheterna
`700`/`600` på Unix och `*.chains/` ignoreras av Git. Ett fel före publicering
lämnar den tidigare filen kvar och rullar tillbaka det nya minnesblocket. Om
processen avbryts efter publicering men före SQL-indexering kan kedjan ligga före
SQL. Ett avbrott före publicering kan lämna en temporär fil som inte används vid
återställning. Strömavbrottets påverkan på katalogmetadata garanteras inte.

Kör bara en skrivande process per kombination av databas och `NODE_ID`. En fil
som ändrats eller tagits bort sedan instansen läste/skrev den avvisas vid nästa
skrivning, men detta är inget lås för samtidiga skrivare. Endast den egna lokala
kedjan lagras på disk; peer-repliker hålls i minnet och byggs upp igen med chain-sync (#40).

### Accesslogg i kedjan

Varje lyckad `GET /api/patients/:id` blir ett signerat block i nodens egen kedja
(`NODE_ID`) och en rad i `access_logs`. Nekade anrop och okända patienter loggas inte.
`GET /api/patients/:id/access-log` läser från kedjan och visar `verified` per post.

**Utvecklingsläge:** nyckelparet för en användare skapas första gången hen läser en
journal, och den publika nyckeln skrivs till `users.public_key`. Den lokala kedjan
sparas och verifieras vid återställning enligt avsnittet om kedjepersistens.
Broadcast till peer skickar signerade block med `block:new` (#39). Accessloggen
visar nu både den egna kedjan och verifierade kopior av anslutna peers kedjor (#40).

### Block broadcast (#39)

After both nodes exchange `peer:hello`, a successful patient-record read sends
the newly signed audit block to the peer. The receiving terminal reports
`block:new from <nodeId>: accepted`. Each receiver keeps a separate in-memory
replica of the sender's chain. It verifies the block structure, index, previous
hash, calculated hash and signature against the user's registered database key
before storing a copy. Incoming blocks are not rebroadcast or appended to the
receiver's own chain. Reciprocal connections send once per peer; duplicate
delivery does not append twice.

A missing predecessor is reported as `missing-history` and rejected without
changing stored data.
The receiver requests missing history through chain sync (#40). Persistence
remains separate work (#30). Received copies are not written
to the shared SQL index again; the originating audit operation already writes it.
Peer identity still comes from the unauthenticated hello introduced in #22;
this is a trusted demo-network transport, not authenticated node identity.
Cryptographic access-event verification does not authenticate the sending node.

Use a separate `DB_PATH` and matching JWT settings for a fresh demo if your old
database still has Swedish roles; preserve the old database and key directory.
Both demo nodes must share the new database. Log in as `doctor1`, then request
`GET /api/patients/1` with its cookie. Confirm `accepted` on the other node, then
repeat in the opposite direction. `npm test` includes this full flow with two
server processes and a temporary database, plus tampering and duplicate tests.

### Chain synchronization (#40)

After each valid peer hello (including reconnects), nodes request one another's
own chains with `chain:request` and `chain:response`. A response contains the
sender's complete chain, including genesis. All hashes, links, node IDs and
non-genesis signatures are verified before a replica is stored. Missing block
history triggers another request. Unanswered requests retry every five seconds
while connected; disconnect/shutdown clears pending timers.

Each node writes only its own chain. Read-only replicas are exposed as defensive
copies. A matching older response cannot truncate newer data, and conflicting
history is rejected rather than selected by a longest-chain rule. No incoming
history replaces the local owner's chain. The access-log endpoint combines
local and replicated chains, filters by patient and sorts newest first.

This supports the configured direct peer topology (`PEER_URL`); it does not
discover or relay arbitrary peers. Each node restores its own chain from disk at
startup (#30); peer replicas are kept in memory and rebuilt with `chain:request`
when the peer answers. See [P2P verification](docs/p2p-test.md) for tested
scenarios and the distinction between a transport outage and a process restart.

### Verifiera kedjan (#28)

`chain.verifyChain()` kontrollerar struktur, genesis, nodtillhörighet, index,
länkar, lagrade hashar och varje access-events signatur mot `users.public_key`.
`chain.verifyChain(blocks)` kontrollerar också en JSON-återläst array utan att
ersätta den egna kedjan. Förväntad nod är alltid den som instansen skapades för.

```js
const result = chain.verifyChain();
// { valid: true, position: null, reason: null }
```

Vid fel returneras `{ valid: false, position, reason }`. `position` är det första
felaktiga blockets nollbaserade plats i arrayen, inklusive genesis på plats 0,
oberoende av blockets lagrade `index`. Fel på kedjeindatan, till exempel en tom
array, ger `position: null`. `reason` är en kort felorsak på engelska.

För senare backend-/P2P-integration finns även den fristående funktionen:

```js
import { verifyChain } from './src/blockchain.js';

const result = verifyChain(blocks, expectedNodeId, signing.verifyAccessEvent);
```

Använd `verifyAccessEvent` från `createAccessSigner(db, keyDirectory)` med den
betrodda användardatabasen. Den fristående funktionen kräver verifieraren och
kastar `TypeError` om den saknas. `expectedNodeId` ska komma från anroparens
nodkonfiguration/instans, inte från kedjans påstådda identitet. Verifieringen är
synkron och använder blockets ursprungliga tidsstämpel. Den ändrar inga block,
hashar eller nycklar. `Blockchain.isValid()` behåller sitt boolean-resultat för
enbart struktur/hash, och `verifyAccessEvent` behåller sitt befintliga gränssnitt.

En giltig kedja bevisar inte att alla slutblock finns kvar. Persistensens
SQL-kontroll upptäcker avkortning om indexet fortfarande känner till senare
block, men SQL är ingen kryptografiskt betrodd referens. Gemensam manipulation
av kedja och index kan inte upptäckas generellt. Merkle-logik ingår inte.

### Reproducera manipuleringstestet (#31)

Kör från `server/` efter `npm ci`. Exemplet skapar en databas i minnet och nya
testnycklar i en temporär katalog. Det öppnar inte den vanliga demodatabasen.
Raden `copy[1].data.patientId = 99` är den manuella ändringen i JSON-kopian:

```bash
node --input-type=module <<'JS'
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccessLog } from './src/access-log.js';

const directory = mkdtempSync(join(tmpdir(), 'bcu-tamper-demo-'));
const db = new Database(':memory:');
try {
  db.exec(readFileSync('../docs/database.sql', 'utf8'));
  const chain = createAccessLog('test-node', db, join(directory, 'test.keys'));
  chain.addAccessLog({ userId: 1, role: 'doctor', patientId: 2, action: 'read' });
  const copy = JSON.parse(JSON.stringify(chain.blockchain.chain));
  console.log('Before:', chain.verifyChain(copy));
  copy[1].data.patientId = 99;
  console.log('After:', chain.verifyChain(copy));
  console.log('Original:', chain.verifyChain());
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
JS
```

Förväntat: `Before` och `Original` är giltiga. `After` ger
`{ valid: false, position: 1, reason: 'Invalid block hash' }`.
Regressionstestet finns i `server/src/chain-verification.test.js`, tillsammans
med ett test där hashar räknas om men den ursprungliga signaturen inte stämmer.

### Tester

Live-note server integration for #41 is described in
[docs/live-notes-integration.md](docs/live-notes-integration.md). Both peers use
the `/peers` namespace; browsers use `/`. Set a shared server-only `PEER_SECRET`
to enable note forwarding. The note POST endpoint and frontend integration are
still required before the complete live-note scenario can be accepted.

Kör `cd server && npm test`. Signerings- och access-loggtester använder temporära
SQLite-filer och nyckelkataloger, inklusive separata processer. Kärntesterna
importerar inte `db.js`. Den verkliga `chain`-exporten testas i en separat process
med tillfällig env-fil och databas, inklusive återställning över två separata
Node-processer. Persistenstesterna täcker även SQL-avvikelser, manipulerad lagring
och rollback vid skrivfel, samt ändrad/avkortad minneshistorik före tillägg.
Den vanliga demodatabasen öppnas inte.
### Kontrollera att de lever

```bash
curl http://localhost:3001/api/health   # {"ok":true,"port":3001,"nodeId":"node-3001","patients":5}
curl http://localhost:3002/api/health   # {"ok":true,"port":3002,"nodeId":"node-3002","patients":5}
```

Frontend ligger i `client/` (se #14).
