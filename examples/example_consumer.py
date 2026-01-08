import asyncio
import inspect
import json
import os
import ssl
import websockets

WS_URL = os.environ.get("BRIDGE_WS_URL", "ws://127.0.0.1:8787")
CLIENT_ID = os.environ.get("BRIDGE_CLIENT_ID", "")
API_KEY = os.environ.get("BRIDGE_API_KEY", "")
EVENT_FORMAT = os.environ.get("BRIDGE_EVENT_FORMAT", "")
FILTER_TOKEN_BALANCES = os.environ.get("BRIDGE_FILTER_TOKEN_BALANCES", "")
# For wss:// with Let's Encrypt, set BRIDGE_CA_CERT to the fullchain or install certifi.
TLS_CA_CERT = os.environ.get("BRIDGE_CA_CERT", "")
TLS_INSECURE = os.environ.get("BRIDGE_INSECURE_TLS", "")

INCLUDE_ACCOUNTS = True
INCLUDE_TOKEN_BALANCE_CHANGES = True
INCLUDE_LOGS = False
INCLUDE_INSTRUCTIONS = os.environ.get("BRIDGE_INCLUDE_INSTRUCTIONS", "").lower() in ("true", "1", "yes")

WATCH_ACCOUNTS = [
    # "YourAtaPubkeyHere",
]

WATCH_MINTS = [
    # "YourMintPubkeyHere",
    "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"
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
    connect_kwargs = {"max_size": 64 * 1024 * 1024}
    if ws_url.lower().startswith("wss://"):
        if TLS_INSECURE.lower() in ("true", "1", "yes"):
            ssl_context = ssl.create_default_context()
            ssl_context.check_hostname = False
            ssl_context.verify_mode = ssl.CERT_NONE
        else:
            ssl_context = ssl.create_default_context()
            if TLS_CA_CERT:
                try:
                    ssl_context.load_verify_locations(TLS_CA_CERT)
                except Exception as exc:
                    raise RuntimeError(f"Failed to load CA cert from {TLS_CA_CERT}: {exc}") from exc
            else:
                try:
                    import certifi
                except Exception:
                    certifi = None
                if certifi is not None:
                    ssl_context.load_verify_locations(certifi.where())
        connect_kwargs["ssl"] = ssl_context
    if headers:
        params = inspect.signature(websockets.connect).parameters
        if "extra_headers" in params:
            connect_kwargs["extra_headers"] = headers
        elif "additional_headers" in params:
            connect_kwargs["additional_headers"] = headers
        else:
            raise RuntimeError("websockets.connect does not support custom headers in this version")
    async with websockets.connect(ws_url, **connect_kwargs) as ws:
        if CLIENT_ID:
            await ws.send(json.dumps({"op": "resume", "clientId": CLIENT_ID}))
        options = {
            "op": "setOptions",
            "includeAccounts": INCLUDE_ACCOUNTS,
            "includeTokenBalanceChanges": INCLUDE_TOKEN_BALANCE_CHANGES,
            "includeLogs": INCLUDE_LOGS,
            "includeInstructions": INCLUDE_INSTRUCTIONS,
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
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
