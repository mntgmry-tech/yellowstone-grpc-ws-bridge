import asyncio
import json
import os
import websockets

WS_URL = os.environ.get("BRIDGE_WS_URL", "ws://127.0.0.1:8787")

WATCH_ACCOUNTS = [
    # "YourAtaPubkeyHere",
]

WATCH_MINTS = [
    # "YourMintPubkeyHere",
]

async def main():
    async with websockets.connect(WS_URL, max_size=64 * 1024 * 1024) as ws:
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
