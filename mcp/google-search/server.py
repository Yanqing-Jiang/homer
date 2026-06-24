#!/usr/bin/env python3
import json, sys, subprocess

# Research grounding routed through Antigravity OAuth (agy-rotate), NOT the metered
# GEMINI_API_KEY / AI Studio grounding — keeps grounded searches off the capped project.
# Tradeoff: agy holds a global keychain lock, so concurrent searches serialize.
AGY_ROTATE = "/Users/yj/bin/agy-rotate"
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
    level, _budget = resolve_budget(thinking_level)
    parts = [query]
    if urls:
        parts.append("URLs to analyze:\n" + "\n".join(urls))
    depth = ("Give a quick, concise answer."
             if level == "fast"
             else "Do thorough research with citations from multiple sources.")
    prompt = (
        "Use Google Search to answer the following. " + depth + " "
        "Return ONLY the findings as concise markdown with inline source URLs. "
        "Do NOT write any files, and do NOT return a file-path or task summary.\n\n"
        + "\n\n".join(parts)
    )

    try:
        proc = subprocess.run(
            [AGY_ROTATE, "--dangerously-skip-permissions", "-p", prompt],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=180,
        )
    except subprocess.TimeoutExpired:
        return "## Search Error\n\nAntigravity OAuth search timed out (180s)."
    except Exception as e:
        return f"## Search Error\n\n{e}"

    out = (proc.stdout or "").strip()
    if not out:
        err = (proc.stderr or "").strip()[:300]
        return f"## Search Error\n\nagy returned no output (exit {proc.returncode}). {err}"
    return f"## Search Results ({level}, via Antigravity OAuth)\n\n{out}"

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
