# Yellowstone gRPC -> WebSocket bridge

This service bridges a Solana Yellowstone gRPC stream to a WebSocket feed so you can
subscribe to Solana transaction activity with a lightweight WS client. It
maintains two gRPC subscriptions (processed + confirmed), caches confirmed block
times, filters transactions by watched accounts/mints, and broadcasts raw or
enhanced transaction JSON events to all connected WebSocket clients.

## What it does

- Opens two gRPC streams (processed and confirmed) against a Yellowstone endpoint.
- Maintains dynamic watchlists for accounts and mints, controlled over WebSocket.
- Emits `status` events with connection state and head slots.
- Emits raw (default) or enhanced `transaction` events, depending on client options.
- Exposes HTTP health and internal metrics endpoints.

## How it works

- Reads configuration from `.env` (via dotenv) or process environment.
- Starts a WebSocket server and tracks connected clients.
- Polls the Solana RPC `getHealth` endpoint and serves `/health`, `/stats`, and `/metrics` over HTTP.
- Pauses gRPC subscriptions when the node is unhealthy and resumes automatically.
- Accepts control messages (`set*`, `add*`, `remove*`) to rewrite gRPC
  subscriptions without restarting the service.
- Subscribes to confirmed block metadata and caches block times for timestamps.
- Parses gRPC stream updates, extracts accounts + instructions, derives native/token
  transfers + account data, and optionally filters token balance changes to the
  watchlists before broadcast.
- Caches token account metadata to enrich token transfer owners/mints.

## Configuration

Environment variables:

- `YELLOWSTONE_HOST` (default `127.0.0.1`)
- `YELLOWSTONE_GRPC_PORT` (default `10000`)
- `YELLOWSTONE_RPC_PORT` (default `8899`)
- `YELLOWSTONE_GRPC_PROTOCOL` (default `http`)
- `YELLOWSTONE_RPC_PROTOCOL` (default `http`)
- `YELLOWSTONE_GRPC_ENDPOINT` (legacy override, used only when `YELLOWSTONE_HOST` and `YELLOWSTONE_GRPC_PORT` are unset)
- `YELLOWSTONE_X_TOKEN` (optional auth token header)
- `SOLANA_RPC_URL` (optional override for RPC health checks + token account cache)
- `BLOCK_CACHE_SIZE` (default `500`) confirmed block metadata cache size for timestamps
- `FILTER_TOKEN_BALANCES` (default `false`) default per-client token balance filtering
- `TOKEN_ACCOUNT_CACHE_MAX_SIZE` (default `100000`) max cached token accounts
- `WS_BIND` (default `0.0.0.0`)
- `WS_PORT` (default `8787`)
- `HEALTH_BIND` (default `0.0.0.0`)
- `HEALTH_PORT` (default `8788`)
- `SOLANA_HEALTHCHECK_INTERVAL_MS` (default `30000`)
- `SOLANA_HEALTHCHECK_TIMEOUT_MS` (default `5000`)
- `SOLANA_HEALTHCHECK_INTERVAL_UNHEALTHY_MS` (default `1000`)
- `GRPC_REQUIRE_HEALTHY` (default `true`) to gate gRPC subscriptions on node health
- `WS_IDLE_TIMEOUT_MS` (default `120000`) to close idle WS connections
- `GRPC_SUBSCRIPTION_RETENTION_MS` (default `120000`) to keep gRPC subscriptions and replay
  missed events for disconnected clients
- `GRPC_RETENTION_MAX_EVENTS` (default `20000`) to cap the in-memory replay buffer (set to `0` to disable replay)
- `CONFIRMED_TX_BUFFER_MS` (default `250`) to briefly delay confirmed transactions to wait for block timestamps
- `GRPC_RETRY_BASE_MS` (default `1000`) base delay for gRPC reconnect backoff
- `GRPC_RETRY_MAX_MS` (default `30000`) max delay for gRPC reconnect backoff
- `WS_RATE_LIMIT_COUNT` (default `25`) control messages per window (set to `0` to disable)
- `WS_RATE_LIMIT_WINDOW_MS` (default `5000`) rate limit window
- `MONGO_URI` (default `mongodb://admin:admin@127.0.0.1:27017/?authSource=admin`)
- `MONGO_DB` (default `yellowstone_bridge`)
- `MONGO_API_KEYS_COLLECTION` (default `api_keys`)
- `MONGO_CONNECT_TIMEOUT_MS` (default `10000`)
- `MONGO_SOCKET_TIMEOUT_MS` (default `10000`)
- `MONGO_MAX_POOL_SIZE` (default `10`)
- `MONGO_MIN_POOL_SIZE` (default `0`)
- `API_KEY_CACHE_MAX_SIZE` (default `100000`) max API key entries held in memory
- `API_KEY_LAST_USED_FLUSH_MS` (default `15000`) batch interval for lastUsed updates
- `BRIDGE_WS_URL` (client examples only, default `ws://127.0.0.1:8787`)
- `BRIDGE_CLIENT_ID` (client examples only, optional resume token)
- `BRIDGE_EVENT_FORMAT` (client examples only, `raw` or `enhanced`)
- `BRIDGE_FILTER_TOKEN_BALANCES` (client examples only, `true` to filter balances)
- `BRIDGE_API_KEY` (client examples only, raw api key without the `Bearer ` prefix)
- `BRIDGE_INCLUDE_INSTRUCTIONS` (client examples only, `true` to include enhanced `instructions`)
- `BRIDGE_CA_CERT` (client examples only, path to a CA bundle for `wss://` endpoints)
- `BRIDGE_INSECURE_TLS` (client examples only, set `true` to skip TLS verification; dev only)

Note: for `wss://` with Let's Encrypt, ensure nginx serves a full chain (leaf + intermediate, typically 2 certs). If Python still fails to verify, install `certifi` or set `BRIDGE_CA_CERT` to the fullchain file.

Copy `example.env` to `.env` to get started.

## Run

With Docker:

```bash
export YELLOWSTONE_HOST="10.1.2.3"
export YELLOWSTONE_GRPC_PORT="10000"
export YELLOWSTONE_RPC_PORT="8899"
# export YELLOWSTONE_X_TOKEN="..."                 # optional

docker compose up -d --build
```

Local build:

```bash
npm install
npm run build
npm start
```

WebSocket server will be at: `ws://<host>:8787`
Health endpoint: `http://<host>:8788/health` (200 when the node is healthy, 503 otherwise)
Stats endpoint: `http://<host>:8788/stats` (snapshot of the log counters)
Metrics endpoints:
- `http://<host>:8788/metrics`
- `http://<host>:8788/admin`
- `http://<host>:8788/metrics/clients`
- `http://<host>:8788/metrics/caches`
- `http://<host>:8788/metrics/grpc`
- `http://<host>:8788/metrics/node`
- `http://<host>:8788/metrics/rpc`
- `http://<host>:8788/metrics/stats`
- `http://<host>:8788/metrics/websocket`
- `http://<host>:8788/metrics/server`
- `http://<host>:8788/metrics/subscriptions`

When the node is unhealthy, the health check interval switches to
`SOLANA_HEALTHCHECK_INTERVAL_UNHEALTHY_MS` and the timeout temporarily drops to
1s so the bridge can reconnect quickly; once healthy, they return to
`SOLANA_HEALTHCHECK_INTERVAL_MS` and `SOLANA_HEALTHCHECK_TIMEOUT_MS`.

## WebSocket control plane

WebSocket connections require an `Authorization: Bearer <api-key>` header. API
keys can be created and managed via the `/admin` UI (internal-only) or
the `/api-keys` endpoints.

Send JSON messages to update watchlists:

- `{"op":"setAccounts","accounts":["<pubkey>", "..."]}`
- `{"op":"addAccounts","accounts":["<pubkey>", "..."]}`
- `{"op":"removeAccounts","accounts":["<pubkey>", "..."]}`
- `{"op":"setMints","mints":["<mint>", "..."]}`
- `{"op":"addMints","mints":["<mint>", "..."]}`
- `{"op":"removeMints","mints":["<mint>", "..."]}`
- `{"op":"resume","clientId":"<client-id>"}`
- `{"op":"getState"}`
- `{"op":"ping"}`
- `{"op":"setOptions","includeAccounts":true,"includeTokenBalanceChanges":true,"includeLogs":false,"includeInstructions":false,"eventFormat":"raw|enhanced","filterTokenBalances":false}`

By default, the bridge emits the raw transaction format and excludes `logs` to
keep payloads small. `accounts` and the token-derived fields (`tokenTransfers`
plus `accountData.tokenBalanceChanges`) are included by default in enhanced mode
and can be disabled via `setOptions` (token transfers become empty and
`accountData` token changes are cleared). Enhanced `instructions` are excluded
by default and can be enabled with `includeInstructions=true`. Set
`filterTokenBalances` to `true` to filter token balance changes to the watched
accounts/mints; by default all token balance changes are included. The server
sends periodic WebSocket pings; missing pongs or inactivity past
`WS_IDLE_TIMEOUT_MS` closes the connection. Any client message (including `ping`)
also counts as activity.

To choose the format at connection time, append `?format=raw` or
`?format=enhanced` to the WebSocket URL (defaults to `raw`).

Control messages are rate-limited per client; messages above the configured
limit are dropped with a warning.

If a client disconnects, its subscriptions are retained for
`GRPC_SUBSCRIPTION_RETENTION_MS`. Reconnect with the last seen `clientId` to
resume and receive missed transactions from the retention window. Set the
retention to `0` to drop subscriptions immediately on disconnect.

The replay buffer is bounded by `GRPC_RETENTION_MAX_EVENTS`; if that limit is
exceeded, the oldest events are dropped.

## Events

`status` events:

- `type`: `status`
- `clientId`: stable ID for resume
- `now`: ISO timestamp
- `grpcConnected`: boolean
- `nodeHealthy`: boolean
- `processedHeadSlot`, `confirmedHeadSlot`: latest observed slots
- `watchedAccounts`, `watchedMints`: watchlist sizes

`transaction` events (raw, default):

- `type`: `transaction`
- `commitment`: `processed` or `confirmed`
- `slot`, `signature`, `isVote`, `index`, `err`
- `accounts`: all accounts from the transaction
- `tokenBalanceChanges`: token balance deltas (filterable via `filterTokenBalances`)
  - `account`, `mint`, `owner`, `decimals`, `preAmount`, `postAmount`, `delta`
- `logs` and `computeUnitsConsumed` when available

`transaction` events (enhanced):

- `type`: `transaction`
- `commitment`: `processed` or `confirmed`
- `slot`, `signature`, `timestamp` (confirmed only), `isVote`, `index`, `err`
- `fee`, `feePayer`
- `accounts`: all accounts from the transaction
- `nativeTransfers`: derived from System Program instructions
- `tokenTransfers`: derived by parsing Token Program instructions (with cached token metadata)
- `accountData`: native balance changes plus raw token deltas
- `instructions`: top-level + inner instructions (base58 data, optional when `includeInstructions=true`)
- `logs` and `computeUnitsConsumed` when available

`accounts` may be omitted if disabled via `setOptions`. `tokenBalanceChanges`
(raw) and `accountData.tokenBalanceChanges` (enhanced) are filtered to the
watched accounts/mints only when `filterTokenBalances=true`; otherwise they
include all token balance changes in the transaction. Enhanced `tokenTransfers`
are derived from Token Program instructions and include intermediate hops; set
`includeTokenBalanceChanges=false` to omit them. `logs` may be omitted if
disabled via `setOptions`. Processed transactions always set `timestamp: null`;
confirmed transactions use the cached block time when available.

## Examples

Two example clients live in `examples/`:

- `examples/example_consumer.py`
  - Uses `websockets` in Python.
  - Run:
    ```bash
    pip install websockets
    BRIDGE_WS_URL="ws://127.0.0.1:8787" BRIDGE_API_KEY="..." BRIDGE_CLIENT_ID="..." python examples/example_consumer.py
    ```
- `examples/ts-client.ts`
  - Uses `ws` and dotenv in TypeScript.
  - Run:
    ```bash
    BRIDGE_WS_URL="ws://127.0.0.1:8787" BRIDGE_API_KEY="..." BRIDGE_CLIENT_ID="..." npm run example:ts-client
    ```
