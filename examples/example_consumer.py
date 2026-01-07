import asyncio
import json
import os
import websockets

WS_URL = os.environ.get("BRIDGE_WS_URL", "ws://127.0.0.1:8787")
CLIENT_ID = os.environ.get("BRIDGE_CLIENT_ID", "")
API_KEY = os.environ.get("BRIDGE_API_KEY", "")
EVENT_FORMAT = os.environ.get("BRIDGE_EVENT_FORMAT", "")
FILTER_TOKEN_BALANCES = os.environ.get("BRIDGE_FILTER_TOKEN_BALANCES", "")

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
    ws_url = WS_URL
    if EVENT_FORMAT.lower() in ("raw", "enhanced"):
        separator = "&" if "?" in WS_URL else "?"
        ws_url = f"{WS_URL}{separator}format={EVENT_FORMAT.lower()}"

    api_key = API_KEY.strip()
    if api_key.lower().startswith("bearer "):
        api_key = api_key[7:].strip()
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else None
    async with websockets.connect(ws_url, max_size=64 * 1024 * 1024, extra_headers=headers) as ws:
        if CLIENT_ID:
            await ws.send(json.dumps({"op": "resume", "clientId": CLIENT_ID}))
        options = {
            "op": "setOptions",
            "includeAccounts": INCLUDE_ACCOUNTS,
            "includeTokenBalanceChanges": INCLUDE_TOKEN_BALANCE_CHANGES,
            "includeLogs": INCLUDE_LOGS,
        }
        if FILTER_TOKEN_BALANCES.lower() in ("true", "1", "yes"):
            options["filterTokenBalances"] = True
        if EVENT_FORMAT.lower() in ("raw", "enhanced"):
            options["eventFormat"] = EVENT_FORMAT.lower()
        await ws.send(json.dumps(options))
        if WATCH_ACCOUNTS:
            await ws.send(json.dumps({"op": "setAccounts", "accounts": WATCH_ACCOUNTS}))
        if WATCH_MINTS:
            await ws.send(json.dumps({"op": "setMints", "mints": WATCH_MINTS}))

        while True:
            msg = await ws.recv()
            ev = json.loads(msg)

            if ev.get("type") == "status":
                if ev.get("clientId"):
                    print("CLIENT_ID:", ev["clientId"])
                print(json.dumps(ev, indent=2))
                continue

            if ev.get("type") == "transaction":
                print(json.dumps(ev, indent=2))

if __name__ == "__main__":
    asyncio.run(main())
