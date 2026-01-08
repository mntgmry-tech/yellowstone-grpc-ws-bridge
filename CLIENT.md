# WebSocket Client Guide

This guide covers everything you need to connect to the bridge WebSocket, authenticate, configure subscriptions, and interpret events.

## Connect

1) Get an API key from your operator (or the internal `/admin` UI).
2) Connect to the WebSocket endpoint with a bearer token:
   - `Authorization: Bearer <api-key>`
3) Send a watchlist (`setAccounts` and/or `setMints`). No transaction events are emitted until you set a watchlist.

For TLS (`wss://`), use a valid CA bundle. If the server uses Let's Encrypt, the full chain should include 2 certs (leaf + intermediate). Python clients may need `certifi` or `BRIDGE_CA_CERT`.

## Control messages

Send JSON control messages after connecting:

```json
{"op":"setAccounts","accounts":["<pubkey>","..."]}
{"op":"addAccounts","accounts":["<pubkey>","..."]}
{"op":"removeAccounts","accounts":["<pubkey>","..."]}
{"op":"setMints","mints":["<mint>","..."]}
{"op":"addMints","mints":["<mint>","..."]}
{"op":"removeMints","mints":["<mint>","..."]}
{"op":"setOptions","includeAccounts":true,"includeTokenBalanceChanges":true,"includeLogs":false,"includeInstructions":false,"eventFormat":"raw|enhanced","filterTokenBalances":false}
{"op":"resume","clientId":"<client-id>"}
{"op":"getState"}
{"op":"ping"}
```

Notes:
- `setAccounts`/`setMints` replace the list. `add*` and `remove*` are incremental.
- `getState` and `ping` return a `status` event.
- You can send control messages at any time to modify watchlists or options; changes apply immediately.
- Control messages are rate-limited per client. Defaults are `WS_RATE_LIMIT_COUNT=25` per `WS_RATE_LIMIT_WINDOW_MS=5000` (5 seconds); messages above the limit are dropped.

## Event format

- Default format is `raw`.
- To choose at connect time: append `?format=raw` or `?format=enhanced` to the WebSocket URL.
- You can also switch formats with `setOptions.eventFormat`.

By default, `includeLogs` is false to reduce payload size. You can disable `includeAccounts` or `includeTokenBalanceChanges` to further reduce traffic.
Enhanced `instructions` are excluded by default; set `includeInstructions=true` to include them.

## Resume and replay

Each client gets a stable `clientId` in the `status` event. On reconnect, send `{"op":"resume","clientId":"<client-id>"}` to resume. Resume is only allowed when using the same API key that created the session. The server retains subscriptions for `GRPC_SUBSCRIPTION_RETENTION_MS`, and the replay buffer is capped by `GRPC_RETENTION_MAX_EVENTS`.

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
- `accounts`: all accounts from the transaction (optional)
- `tokenBalanceChanges`: token balance deltas (optional, filterable via `filterTokenBalances`)
  - `account`, `mint`, `owner`, `decimals`, `preAmount`, `preAmountUi`, `postAmount`, `postAmountUi`, `delta`, `deltaUi`
- `logs` and `computeUnitsConsumed` when available

`transaction` events (enhanced):

- `type`: `transaction`
- `commitment`: `processed` or `confirmed`
- `slot`, `signature`, `timestamp` (confirmed only), `isVote`, `index`, `err`
- `fee`, `feePayer`
- `accounts`: all accounts from the transaction (optional)
- `nativeTransfers`: derived from System Program instructions
- `tokenTransfers`: derived by parsing Token Program instructions (with cached token metadata)
- `accountData`: native balance changes plus raw token deltas
- `instructions`: top-level + inner instructions (base58 data, optional when `includeInstructions=true`)
- `logs` and `computeUnitsConsumed` when available

`accounts` may be omitted if disabled via `setOptions`. `tokenBalanceChanges` (raw) and `accountData.tokenBalanceChanges` (enhanced) are filtered to the watched accounts/mints only when `filterTokenBalances=true`; otherwise they include all token balance changes in the transaction. Enhanced `tokenTransfers` are derived from Token Program instructions and include intermediate hops; set `includeTokenBalanceChanges=false` to omit them. `logs` may be omitted if disabled via `setOptions`. Processed transactions always set `timestamp: null`; confirmed transactions use the cached block time when available.

## Event examples

Status event:

```json
{
  "type": "status",
  "clientId": "c97ef1f0-d1f3-4dfc-a15e-a428a6528d7f",
  "now": "2024-07-01T12:34:56.789Z",
  "grpcConnected": true,
  "nodeHealthy": true,
  "processedHeadSlot": 226543210,
  "confirmedHeadSlot": 226543200,
  "watchedAccounts": 2,
  "watchedMints": 1
}
```

Raw transaction event:

```json
{
  "type": "transaction",
  "commitment": "processed",
  "slot": 226543210,
  "signature": "5dN1j2x...ZyX",
  "isVote": false,
  "index": 12,
  "err": null,
  "accounts": [
    "9xQeWvG816bUx9EPfQtuLXBb5y6Cq9M6g6C3CbV5F7RX",
    "So11111111111111111111111111111111111111112"
  ],
  "tokenBalanceChanges": [
    {
      "account": "9xQeWvG816bUx9EPfQtuLXBb5y6Cq9M6g6C3CbV5F7RX",
      "mint": "So11111111111111111111111111111111111111112",
      "owner": "F3s7q9Z6aC7A7G1mQJfYpZ2j8R8C2t2xqGk9nW2t4cVw",
      "decimals": 9,
      "preAmount": "1500000000",
      "preAmountUi": "1.5",
      "postAmount": "1200000000",
      "postAmountUi": "1.2",
      "delta": "-300000000",
      "deltaUi": "-0.3"
    }
  ],
  "logs": ["Program log: Instruction: Transfer"],
  "computeUnitsConsumed": 18234
}
```

Enhanced transaction event:

```json
{
  "type": "transaction",
  "commitment": "confirmed",
  "slot": 226543200,
  "signature": "4F2s9pB...1xQ",
  "timestamp": 1719856492,
  "isVote": false,
  "index": 3,
  "err": null,
  "fee": 5000,
  "feePayer": "F3s7q9Z6aC7A7G1mQJfYpZ2j8R8C2t2xqGk9nW2t4cVw",
  "accounts": [
    "F3s7q9Z6aC7A7G1mQJfYpZ2j8R8C2t2xqGk9nW2t4cVw",
    "So11111111111111111111111111111111111111112"
  ],
  "nativeTransfers": [
    {
      "fromUserAccount": "F3s7q9Z6aC7A7G1mQJfYpZ2j8R8C2t2xqGk9nW2t4cVw",
      "toUserAccount": "9xQeWvG816bUx9EPfQtuLXBb5y6Cq9M6g6C3CbV5F7RX",
      "amount": 1000000
    }
  ],
  "tokenTransfers": [
    {
      "fromTokenAccount": "8qkGf5...pZq",
      "toTokenAccount": "5nY8h2...kLm",
      "fromUserAccount": "F3s7q9Z6aC7A7G1mQJfYpZ2j8R8C2t2xqGk9nW2t4cVw",
      "toUserAccount": "9xQeWvG816bUx9EPfQtuLXBb5y6Cq9M6g6C3CbV5F7RX",
      "tokenAmount": 12.34,
      "mint": "So11111111111111111111111111111111111111112",
      "tokenStandard": "spl"
    }
  ],
  "accountData": [
    {
      "account": "9xQeWvG816bUx9EPfQtuLXBb5y6Cq9M6g6C3CbV5F7RX",
      "nativeBalanceChange": -5000,
      "tokenBalanceChanges": [
        {
          "userAccount": "9xQeWvG816bUx9EPfQtuLXBb5y6Cq9M6g6C3CbV5F7RX",
          "tokenAccount": "8qkGf5...pZq",
          "rawTokenAmount": { "tokenAmount": "1230000", "decimals": 6 },
          "mint": "So11111111111111111111111111111111111111112"
        }
      ]
    }
  ],
  "instructions": [
    {
      "programId": "11111111111111111111111111111111",
      "accounts": ["F3s7q9Z6aC7A7G1mQJfYpZ2j8R8C2t2xqGk9nW2t4cVw"],
      "data": "3Bxs5s7g",
      "innerInstructions": [
        {
          "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          "accounts": ["8qkGf5...pZq", "5nY8h2...kLm"],
          "data": "4S1aZQ"
        }
      ]
    }
  ],
  "computeUnitsConsumed": 18234,
  "logs": ["Program log: Instruction: Transfer"]
}
```

## Example clients

Python:

```bash
pip install websockets certifi
BRIDGE_WS_URL="wss://<host>" \
BRIDGE_API_KEY="..." \
BRIDGE_CLIENT_ID="..." \
python3 examples/example_consumer.py
```

Optional TLS helpers:

- `BRIDGE_CA_CERT=/path/to/fullchain.pem` to supply a CA bundle for `wss://`.
- `BRIDGE_INSECURE_TLS=true` to skip TLS verification (dev only).

TypeScript:

```bash
BRIDGE_WS_URL="wss://<host>" \
BRIDGE_API_KEY="..." \
BRIDGE_CLIENT_ID="..." \
npm run example:ts-client
```

Client example environment variables:

- `BRIDGE_WS_URL` (default `ws://127.0.0.1:8787`)
- `BRIDGE_API_KEY` (raw api key without the `Bearer ` prefix)
- `BRIDGE_CLIENT_ID` (optional resume token)
- `BRIDGE_EVENT_FORMAT` (`raw` or `enhanced`)
- `BRIDGE_FILTER_TOKEN_BALANCES` (`true` to filter balances)
- `BRIDGE_INCLUDE_INSTRUCTIONS` (`true` to include enhanced `instructions`)
- `BRIDGE_CA_CERT` (path to CA bundle for `wss://`)
- `BRIDGE_INSECURE_TLS` (`true` to skip TLS verification; dev only)
