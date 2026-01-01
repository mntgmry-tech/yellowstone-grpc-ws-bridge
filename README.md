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

## How it works

- Reads configuration from `.env` (via dotenv) or process environment.
- Starts a WebSocket server and tracks connected clients.
- Accepts control messages (`set*`, `add*`, `remove*`) to rewrite gRPC
  subscriptions without restarting the service.
- Parses gRPC stream updates, extracts accounts and token balance changes, and
  filters token balance changes to the watched accounts/mints before broadcast.

## Configuration

Environment variables:

- `YELLOWSTONE_GRPC_ENDPOINT` (default `127.0.0.1:10000`)
  - Accepts `host:port` or full `http(s)://` URL.
- `YELLOWSTONE_X_TOKEN` (optional auth token header).
- `WS_BIND` (default `0.0.0.0`)
- `WS_PORT` (default `8787`)
- `BRIDGE_WS_URL` (client examples only, default `ws://127.0.0.1:8787`)

Copy `example.env` to `.env` to get started.

## Run

With Docker:

```bash
export YELLOWSTONE_GRPC_ENDPOINT="10.1.2.3:10000"   # or "http://10.1.2.3:10000"
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

## WebSocket control plane

Send JSON messages to update watchlists:

- `{"op":"setAccounts","accounts":["<pubkey>", "..."]}`
- `{"op":"addAccounts","accounts":["<pubkey>", "..."]}`
- `{"op":"removeAccounts","accounts":["<pubkey>", "..."]}`
- `{"op":"setMints","mints":["<mint>", "..."]}`
- `{"op":"addMints","mints":["<mint>", "..."]}`
- `{"op":"removeMints","mints":["<mint>", "..."]}`
- `{"op":"getState"}`
- `{"op":"ping"}`

## Events

`status` events:

- `type`: `status`
- `now`: ISO timestamp
- `grpcConnected`: boolean
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

## Examples

Two example clients live in `examples/`:

- `examples/example_consumer.py`
  - Uses `websockets` in Python.
  - Run:
    ```bash
    pip install websockets
    BRIDGE_WS_URL="ws://127.0.0.1:8787" python examples/example_consumer.py
    ```
- `examples/ts-client.ts`
  - Uses `ws` and dotenv in TypeScript.
  - Run (compile first):
    ```bash
    npx tsc --target ES2022 --module commonjs --outDir dist examples/ts-client.ts
    BRIDGE_WS_URL="ws://127.0.0.1:8787" node dist/ts-client.js
    ```
