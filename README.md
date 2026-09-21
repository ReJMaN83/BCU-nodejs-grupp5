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

### En server per dator

```bash
cp .env.example .env    # sätt PORT, NODE_ID och PEER_URL (den andra datorns IP)
npm run dev
```

### Databasen

`DB_PATH` (standard `../data/journal.db`, relativt `server/`) pekar ut SQLite-filen som båda instanserna delar. Finns inte tabellerna skapas de från `docs/database.sql` med seed-data när servern startar. Ta bort `data/journal.db*` för att börja om med en ny databas. Seed-användarna (`lakare1`, `sjukskoterska1`, `vardcentral1`, `patient1`, `obehorig1`) har lösenordet `demo1234`. `JWT_SECRET` måste vara samma på båda instanserna, annars godtas inte varandras cookies.

### Kontrollera att de lever

```bash
curl http://localhost:3001/api/health   # {"ok":true,"port":3001,"nodeId":"node-3001","patients":5}
curl http://localhost:3002/api/health   # {"ok":true,"port":3002,"nodeId":"node-3002","patients":5}
```

Frontend ligger i `client/` (se #14).
