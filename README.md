# Yellowstone gRPC -> WebSocket bridge

This service bridges a Solana Yellowstone gRPC stream to a WebSocket feed so you can
subscribe to Solana transaction activity with a lightweight WS client. It
maintains two gRPC subscriptions (processed + confirmed), filters token balance
changes to watched accounts/mints, and broadcasts structured JSON events to all
connected WebSocket clients.

## What it does

- Opens two gRPC streams (processed and confirmed) against a Yellowstone endpoint.
- Maintains dynamic watchlists for accounts and mints, controlled over WebSocket.
- Emits `status` events with connection state and head slots.
- Emits `transaction` events with slot, signature, accounts, and token balance deltas.
- Exposes an HTTP health endpoint that reports node health.

## How it works

- Reads configuration from `.env` (via dotenv) or process environment.
- Starts a WebSocket server and tracks connected clients.
- Polls the Solana RPC `getHealth` endpoint and serves `/health` over HTTP.
- Pauses gRPC subscriptions when the node is unhealthy and resumes automatically.
- Accepts control messages (`set*`, `add*`, `remove*`) to rewrite gRPC
  subscriptions without restarting the service.
- Parses gRPC stream updates, extracts accounts and token balance changes, and
  filters token balance changes to the watched accounts/mints before broadcast.

## Configuration

Environment variables:

- `YELLOWSTONE_HOST` (default `127.0.0.1`)
- `YELLOWSTONE_GRPC_PORT` (default `10000`)
- `YELLOWSTONE_RPC_PORT` (default `8899`)
- `YELLOWSTONE_GRPC_PROTOCOL` (default `http`)
- `YELLOWSTONE_RPC_PROTOCOL` (default `http`)
- `YELLOWSTONE_GRPC_ENDPOINT` (legacy override, used only when `YELLOWSTONE_HOST` and `YELLOWSTONE_GRPC_PORT` are unset)
- `YELLOWSTONE_X_TOKEN` (optional auth token header)
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
- `GRPC_RETRY_BASE_MS` (default `1000`) base delay for gRPC reconnect backoff
- `GRPC_RETRY_MAX_MS` (default `30000`) max delay for gRPC reconnect backoff
- `WS_RATE_LIMIT_COUNT` (default `25`) control messages per window (set to `0` to disable)
- `WS_RATE_LIMIT_WINDOW_MS` (default `5000`) rate limit window
- `BRIDGE_WS_URL` (client examples only, default `ws://127.0.0.1:8787`)
- `BRIDGE_CLIENT_ID` (client examples only, optional resume token)

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

When the node is unhealthy, the health check interval switches to
`SOLANA_HEALTHCHECK_INTERVAL_UNHEALTHY_MS` and the timeout temporarily drops to
1s so the bridge can reconnect quickly; once healthy, they return to
`SOLANA_HEALTHCHECK_INTERVAL_MS` and `SOLANA_HEALTHCHECK_TIMEOUT_MS`.

## WebSocket control plane

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
- `{"op":"setOptions","includeAccounts":true,"includeTokenBalanceChanges":true,"includeLogs":false}`

By default, `logs` are excluded to keep payloads small. `accounts` and
`tokenBalanceChanges` are included by default and can be disabled via
`setOptions`. The server sends periodic WebSocket pings; missing pongs or
inactivity past `WS_IDLE_TIMEOUT_MS` closes the connection. Any client message
(including `ping`) also counts as activity.

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

`transaction` events:

- `type`: `transaction`
- `commitment`: `processed` or `confirmed`
- `slot`, `signature`, `isVote`, `index`, `err`
- `accounts`: all accounts from the transaction
- `tokenBalanceChanges`: filtered to watched accounts/mints
  - `account`, `mint`, `owner`, `decimals`, `preAmount`, `postAmount`, `delta`
- `logs` and `computeUnitsConsumed` when available

`accounts`, `tokenBalanceChanges`, and `logs` may be omitted if disabled via
`setOptions`.

## Examples

Two example clients live in `examples/`:

- `examples/example_consumer.py`
  - Uses `websockets` in Python.
  - Run:
    ```bash
    pip install websockets
    BRIDGE_WS_URL="ws://127.0.0.1:8787" BRIDGE_CLIENT_ID="..." python examples/example_consumer.py
    ```
- `examples/ts-client.ts`
  - Uses `ws` and dotenv in TypeScript.
  - Run (compile first):
    ```bash
    npx tsc --target ES2022 --module commonjs --outDir dist examples/ts-client.ts
    BRIDGE_WS_URL="ws://127.0.0.1:8787" BRIDGE_CLIENT_ID="..." node dist/ts-client.js
    ```
