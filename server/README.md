# Factionops Server

Backend server for a Torn.com faction war coordination tool. Provides real-time target calling, rally coordination, enemy status tracking, and chain monitoring via WebSockets.

## Tech Stack

- **Express.js** – REST API
- **Socket.IO** – Real-time WebSocket communication
- **JWT** – Authentication (verified via Torn API)
- **In-memory store** – With JSON file persistence for restarts

## Setup

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Edit .env and set a strong JWT_SECRET
# e.g. JWT_SECRET=$(openssl rand -hex 32)

# Start the server
npm start

# Or with auto-reload during development (Node 18+)
npm run dev
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server listen port |
| `JWT_SECRET` | (required) | Secret for JWT signing |
| `CALL_EXPIRE_MS` | `300000` | Call auto-expire time in ms (default 5 min) |
| `DATA_DIR` | `./data` | Directory for persisted war state |

## API Endpoints

### `POST /api/auth`

Authenticate with a Torn API key. The server verifies the key against the Torn API and returns a JWT.

**Request:**
```json
{ "apiKey": "your_torn_api_key" }
```

**Response:**
```json
{
  "token": "jwt_token_here",
  "player": {
    "playerId": "12345",
    "playerName": "PlayerName",
    "factionId": "456",
    "factionName": "FactionName"
  }
}
```

### `GET /api/faction/:factionId/war`

Get current war state (calls, rallies, enemy statuses). Requires JWT in `Authorization: Bearer <token>` header.

### `GET /api/faction/:factionId/chain`

Get enemy faction chain monitoring data. Requires JWT.

### `GET /health`

Health check endpoint. No auth required.

## Socket.IO Events

Connect with `auth: { token: "jwt_token" }` in the handshake.

### Client → Server

| Event | Payload | Description |
|---|---|---|
| `join_war` | `{ warId, factionId, enemyFactionId? }` | Join a war room |
| `call_target` | `{ targetId, targetName }` | Reserve an enemy target |
| `uncall_target` | `{ targetId }` | Release a target |
| `rally_target` | `{ targetId, targetName, message }` | Start a rally |
| `join_rally` | `{ targetId }` | Join an existing rally |
| `leave_rally` | `{ targetId }` | Leave a rally |
| `cancel_rally` | `{ targetId }` | Cancel a rally (creator only) |
| `update_status` | `{ targetId, status, until? }` | Update enemy status |
| `refresh_statuses` | `{ factionId }` | Batch-refresh enemy statuses via Torn API |

### Server → Client

| Event | Payload | Description |
|---|---|---|
| `war_state` | Full war state object | Sent on `join_war` |
| `target_called` | `{ targetId, targetName, calledBy, timestamp }` | Target reserved |
| `target_uncalled` | `{ targetId, reason }` | Target released |
| `rally_started` | `{ targetId, targetName, createdBy, message, participants }` | Rally created |
| `rally_updated` | `{ targetId, participants }` | Rally membership changed |
| `rally_cancelled` | `{ targetId }` | Rally cancelled |
| `status_updated` | `{ targetId, status, until, updatedBy }` | Enemy status changed |
| `statuses_refreshed` | `{ statuses }` | Bulk status refresh |
| `chain_update` | `{ factionId, current, max, timeout, ... }` | Chain data update |
| `chain_bonus_alert` | `{ current, nextBonus, hitsAway }` | Approaching bonus hit |
| `chain_timeout_warning` | `{ current, timeout }` | Chain about to expire |
| `error` | `{ message }` | Error message |

## Key Behaviors

- **Call expiry**: Calls auto-expire after 5 minutes (configurable via `CALL_EXPIRE_MS`)
- **Hospital soft-uncall**: If a called target goes to hospital, the call is released after 30 seconds
- **Refresh rate limit**: Status refreshes are limited to once per 30 seconds per war room
- **Chain monitoring**: Enemy chain is polled every 30 seconds with bonus-hit and timeout alerts
- **Persistence**: War state is saved to `./data/wars.json` on every change and reloaded on startup
- **Disconnect handling**: Players are removed from the online list on disconnect but calls are preserved (they may reconnect)

## Project Structure

```
server/
├── server.js           # Entry point – Express + Socket.IO setup
├── auth.js             # JWT issuance/verification, Torn API auth
├── routes.js           # REST API endpoints
├── socket-handlers.js  # Socket.IO event handlers
├── chain-monitor.js    # Periodic chain polling service
├── torn-api.js         # Torn API helper functions
├── store.js            # In-memory store with file persistence
├── data/               # Persisted war state (auto-created)
│   └── wars.json
├── .env.example        # Environment config template
└── package.json
```
