import asyncio
import json
import os
import websockets

WS_URL = os.environ.get("BRIDGE_WS_URL", "ws://127.0.0.1:8787")
CLIENT_ID = os.environ.get("BRIDGE_CLIENT_ID", "")

INCLUDE_ACCOUNTS = True
INCLUDE_TOKEN_BALANCE_CHANGES = True
INCLUDE_LOGS = False

WATCH_ACCOUNTS = [
    # "YourAtaPubkeyHere",
]

WATCH_MINTS = [
    # "YourMintPubkeyHere",
]

async def main():
    async with websockets.connect(WS_URL, max_size=64 * 1024 * 1024) as ws:
        if CLIENT_ID:
            await ws.send(json.dumps({"op": "resume", "clientId": CLIENT_ID}))
        await ws.send(
            json.dumps(
                {
                    "op": "setOptions",
                    "includeAccounts": INCLUDE_ACCOUNTS,
                    "includeTokenBalanceChanges": INCLUDE_TOKEN_BALANCE_CHANGES,
                    "includeLogs": INCLUDE_LOGS,
                }
            )
        )
        if WATCH_ACCOUNTS:
            await ws.send(json.dumps({"op": "setAccounts", "accounts": WATCH_ACCOUNTS}))
        if WATCH_MINTS:
            await ws.send(json.dumps({"op": "setMints", "mints": WATCH_MINTS}))

        while True:
            msg = await ws.recv()
            ev = json.loads(msg)

            if ev.get("type") == "status":
                print("STATUS:", ev)
                continue

            if ev.get("type") == "transaction":
                print(
                    ev["commitment"],
                    "slot",
                    ev["slot"],
                    "sig",
                    ev["signature"],
                    "tokenBalanceChanges",
                    ev.get("tokenBalanceChanges", []),
                )

if __name__ == "__main__":
    asyncio.run(main())
