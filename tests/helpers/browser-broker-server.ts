import { BrowserLeaseBroker, startBrowserControlServer, stopBrowserControlServer, type BrowserTargetClient } from "../../src/scraping/browser-control.js";

let nextTarget = 1;
const targets = new Map<string, { id: string; type: string; url: string; webSocketDebuggerUrl: string }>();
const client: BrowserTargetClient = {
  list: async () => [...targets.values()],
  create: async (url) => {
    const id = `target-${nextTarget++}`;
    const target = { id, type: "page", url, webSocketDebuggerUrl: `ws://broker.test/devtools/page/${id}` };
    targets.set(id, target);
    return target;
  },
  close: async (id) => { targets.delete(id); },
};

const broker = new BrowserLeaseBroker(client);
broker.beginGeneration(Number(process.env.BROKER_GENERATION ?? "1"));
const socketPath = process.env.HOMER_BROWSER_CONTROL_SOCKET!;
const server = startBrowserControlServer(broker, async (enabled) => {
  if (enabled) await broker.drainLeases(100);
  else broker.resume();
}, socketPath);
server.on("listening", () => process.stdout.write("READY\n"));

const shutdown = () => { void stopBrowserControlServer(server, socketPath).finally(() => process.exit(0)); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
