# Frontend – BCU-nodejs-grupp5

React + Vite-klient för journalsystemet. Se projektets [huvud-README](../README.md)
för hur backend startas och för P2P-arkitekturen.

## Installation

```bash
cd client
npm install
```

## Miljövariabler

Kopiera `.env.example` till `.env`:

```bash
cp .env.example .env
```

`.env` ska innehålla:
VITE_API_URL=http://localhost:3001


Sätt den till den servern du vill prata med (t.ex. `http://localhost:3002` om du testar
mot den andra noden). Saknas `.env` helt faller klienten tillbaka på
`http://localhost:3001` automatiskt.

## Starta

Se till att backend körs först (se huvud-README, `server/`), kör sedan:

```bash
npm run dev
```

Klienten startar på `http://localhost:5173`.

## Testkonton

Seedade användare (lösenord `demo1234` för alla):

| Användarnamn | Roll |
|---|---|
| `doctor1` | Läkare |
| `nurse1` | Sjuksköterska |
| `clinic1` | Vårdcentral |
| `patient1` | Patient |
| `unauthorized1` | Obehörig |

## Lint

```bash
npm run lint
```

## Struktur
src/
├── api/ API-klient (client.js) och socket.io-anslutning (socket.js)
├── context/ AuthContext (inloggad användare, delad state)
├── pages/ En fil per sida/route
└── App.jsx Routing och rollskydd (ProtectedRoute)

EOF