#!/usr/bin/env python3
import json, sys, os, urllib.request, urllib.error

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
MODEL = "gemini-3.5-flash"
BASE = "https://generativelanguage.googleapis.com/v1beta/models"
BUDGETS = {"fast": 4096, "deep": 16384}

TOOL_DEF = {
    "name": "google_search",
    "description": "Search the web using Google Search with Gemini 3.5 Flash grounding. Use \"fast\" for quick answers (4096 budget) or \"deep\" for thorough research with citations (16384 budget).",
    "inputSchema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "The search query or question to answer using web search"},
            "urls": {"type": "array", "items": {"type": "string"}, "description": "Specific URLs to fetch and analyze"},
            "thinking_level": {
                "type": "string",
                "enum": ["fast", "deep"],
                "description": "\"fast\" for quick answers (budget 4096) or \"deep\" for thorough research (budget 16384). Default: deep.",
            },
        },
        "required": ["query"],
    },
}

def send(msg):
    line = json.dumps(msg)
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

def resolve_budget(level):
    if level is None:
        return "deep", BUDGETS["deep"]
    return level, BUDGETS.get(level, BUDGETS["deep"])

def search_gemini(query, urls=None, thinking_level=None):
    prompt = query
    if urls:
        prompt = f"{query}\n\nURLs to analyze:\n" + "\n".join(urls)

    level, budget = resolve_budget(thinking_level)

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "tools": [{"googleSearch": {}}],
        "generationConfig": {
            "thinkingConfig": {"thinkingBudget": budget, "includeThoughts": False}
        },
    }

    url = f"{BASE}/{MODEL}:generateContent?key={GEMINI_API_KEY}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return f"## Search Error\n\nHTTP {e.code}: {body}"
    except Exception as e:
        return f"## Search Error\n\n{e}"

    candidate = (data.get("candidates") or [None])[0]
    if not candidate:
        return "## Search Error\n\nNo response from Gemini."

    text = ""
    parts = (candidate.get("content") or {}).get("parts") or []
    for p in parts:
        if "text" in p:
            text += p["text"]

    sections = [f"## Search Results ({level}, budget={budget})\n", text, ""]
    gm = candidate.get("groundingMetadata") or {}
    queries = gm.get("webSearchQueries") or []
    chunks = gm.get("groundingChunks") or []

    if chunks:
        sections.append("### Sources")
        for c in chunks:
            w = c.get("web") or {}
            if w.get("uri"):
                sections.append(f"- [{w.get('title', w['uri'])}]({w['uri']})")
        sections.append("")

    if queries:
        sections.append("### Search Queries Used")
        for q in queries:
            sections.append(f'- "{q}"')

    return "\n".join(sections)

def main():
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
                "serverInfo": {"name": "google-search", "version": "2.0.0"},
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
            params = msg.get("params", {})
            args = params.get("arguments", {})
            result = search_gemini(
                args.get("query", ""),
                args.get("urls"),
                args.get("thinking_level"),
            )
            send({
                "jsonrpc": "2.0",
                "id": _id,
                "result": {"content": [{"type": "text", "text": result}]},
            })

if __name__ == "__main__":
    main()
