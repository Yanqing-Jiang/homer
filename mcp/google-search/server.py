#!/usr/bin/env python3
import json, sys, os, threading, itertools, urllib.request, urllib.error

# Grounded search via the official Gemini API (google_search tool), NOT agy/Antigravity.
# API-key auth has no keychain lock, so calls run fully parallel. Multiple keys (one per
# Google-account project) round-robin for combined free quota (~5k grounded prompts/mo each)
# and failover on rate limits. Set GEMINI_GROUNDING_KEYS=key1,key2,... in the MCP env.
MODEL = os.environ.get("GEMINI_GROUNDING_MODEL", "gemini-3-flash-preview")
API_KEYS = [k.strip() for k in os.environ.get("GEMINI_GROUNDING_KEYS", "").split(",") if k.strip()]
THINK_LEVEL = {"fast": "low", "deep": "high"}

_key_cycle = itertools.cycle(API_KEYS) if API_KEYS else None
_key_lock = threading.Lock()   # guards only the round-robin counter, NOT the HTTP call
_send_lock = threading.Lock()  # serializes stdout framing across worker threads

TOOL_DEF = {
    "name": "google_search",
    "description": "Search the web using Google Search with Gemini 3 Flash grounding. Use \"fast\" for quick answers or \"deep\" for thorough research with citations.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "The search query or question to answer using web search"},
            "urls": {"type": "array", "items": {"type": "string"}, "description": "Specific URLs to fetch and analyze"},
            "thinking_level": {
                "type": "string",
                "enum": ["fast", "deep"],
                "description": "\"fast\" for quick answers or \"deep\" for thorough research with citations. Default: fast.",
            },
        },
        "required": ["query"],
    },
}

def send(msg):
    line = json.dumps(msg)
    with _send_lock:  # worker threads may respond concurrently; keep frames intact
        sys.stdout.write(f"Content-Length: {len(line)}\r\n\r\n{line}")
        sys.stdout.flush()

def read_msg():
    raw = sys.stdin.buffer
    content_length = 0
    while True:
        header = raw.readline()
        if not header:
            return None
        if header.strip() == b"":
            break
        if header.lower().startswith(b"content-length:"):
            content_length = int(header.split(b":")[1].strip())
    if content_length == 0:
        return None
    body = raw.read(content_length)
    return json.loads(body)

def _next_key():
    with _key_lock:
        return next(_key_cycle)

def _call_gemini(prompt, level, api_key):
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "tools": [{"google_search": {}}],
    }
    if MODEL.startswith("gemini-3"):  # thinkingLevel is Gemini-3-only; 2.x rejects it
        payload["generationConfig"] = {"thinkingConfig": {"thinkingLevel": THINK_LEVEL.get(level, "high")}}
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent",
        data=body, method="POST",
        headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())

def search_gemini(query, urls=None, thinking_level=None):
    if not _key_cycle:
        return "## Search Error\n\nNo API keys. Set GEMINI_GROUNDING_KEYS in the MCP env."
    level = thinking_level if thinking_level in THINK_LEVEL else "fast"
    parts = [query]
    if urls:
        parts.append("URLs to analyze:\n" + "\n".join(urls))
    depth = ("Give a quick, concise answer."
             if level == "fast"
             else "Do thorough research with citations from multiple sources.")
    prompt = (
        "Use Google Search to answer the following. " + depth + " "
        "Return ONLY the findings as concise markdown with inline source URLs.\n\n"
        + "\n\n".join(parts)
    )

    # DEBT: single round-robin pass with no backoff; on transient 429 across all keys we just
    # surface the error. Upgrade to exponential backoff when grounded-search QPS sustains > free RPM.
    last_err = ""
    for _ in range(len(API_KEYS)):
        try:
            data = _call_gemini(prompt, level, _next_key())
        except urllib.error.HTTPError as e:
            last_err = f"HTTP {e.code}: {e.read().decode(errors='replace')[:200]}"
            if e.code in (429, 500, 503):  # rate-limited / transient → try next key
                continue
            return f"## Search Error\n\n{last_err}"
        except Exception as e:
            last_err = str(e)
            continue
        try:
            cand = data["candidates"][0]
            text = "".join(p.get("text", "") for p in cand["content"]["parts"] if "text" in p)
            chunks = cand.get("groundingMetadata", {}).get("groundingChunks", [])
            cites = [c["web"]["uri"] for c in chunks if "web" in c and c["web"].get("uri")]
        except (KeyError, IndexError):
            return f"## Search Error\n\nUnexpected response shape: {json.dumps(data)[:300]}"
        src = "\n".join(f"- {u}" for u in cites) if cites else "_(no sources returned)_"
        return f"## Search Results ({level}, via Gemini API)\n\n{text}\n\n### Sources\n{src}"

    return f"## Search Error\n\nAll {len(API_KEYS)} keys failed. Last: {last_err}"

def main():
    workers = []
    while True:
        msg = read_msg()
        if msg is None:
            break

        method = msg.get("method")
        _id = msg.get("id")

        if method == "initialize":
            send({"jsonrpc": "2.0", "id": _id, "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "google-search", "version": "3.0.0"},
            }})
        elif method == "notifications/initialized":
            continue
        elif method == "shutdown":
            send({"jsonrpc": "2.0", "id": _id, "result": None})
            break
        elif method == "exit":
            break
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": _id, "result": {"tools": [TOOL_DEF]}})
        elif method == "tools/call":
            # Handle each call in its own thread so a blocking HTTP request never stalls
            # the read loop — this is what lets concurrent google_search calls run parallel.
            def handle(_id=_id, args=msg.get("params", {}).get("arguments", {})):
                result = search_gemini(
                    args.get("query", ""), args.get("urls"), args.get("thinking_level"),
                )
                send({"jsonrpc": "2.0", "id": _id,
                      "result": {"content": [{"type": "text", "text": result}]}})
            t = threading.Thread(target=handle, daemon=True)
            t.start()
            workers.append(t)

    for t in workers:  # drain in-flight calls before exiting on EOF/shutdown
        t.join(timeout=125)

if __name__ == "__main__":
    main()
