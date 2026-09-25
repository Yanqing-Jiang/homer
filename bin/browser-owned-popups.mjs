/** Popup routing for a single browserctl RPC lease. No caller receives CDP access. */
export function verifyLease(status, identity) {
  if (status?.state !== "ready" || status.instance !== identity.instance || status.cdpEndpoint !== identity.cdpEndpoint) throw new Error("browser lease instance is no longer ready");
  const record = status.leases?.find(row => row.leaseId === identity.leaseId && row.targetId === identity.rootId && row.surface === identity.surface);
  if (!record || record.generation !== identity.generation || !Number.isFinite(record.leaseExpiresAt) || record.leaseExpiresAt <= Date.now() || (record.owner !== identity.owner && record.adopterOwner !== identity.owner)) throw new Error("browser lease root, owner, or generation changed");
  const reservation = status.reservations?.find(row => row.leaseId === identity.leaseId);
  if (reservation && (reservation.expiresAt <= Date.now() || reservation.surface !== identity.surface || (reservation.owner !== identity.owner && reservation.adopterOwner !== identity.owner))) throw new Error("browser reservation changed or expired");
  return record;
}

export function ownedPopups(status, infos, identity) {
  verifyLease(status, identity);
  const byId = new Map(infos.filter(row => row.type === "page").map(row => [row.id, row]));
  if (!byId.has(identity.rootId)) throw new Error("browser lease root disappeared");
  const protectedRoots = new Set((status.leases ?? []).filter(row => row.targetId !== identity.rootId).map(row => row.targetId));
  const result = [];
  for (const info of byId.values()) {
    if (info.id === identity.rootId || protectedRoots.has(info.id)) continue;
    const visited = new Set([info.id]);
    let cursor = info;
    for (let depth = 0; depth < 32; depth++) {
      // openerFrameId is a frame identifier, not proof of a live parent target.
      const parentId = cursor.openerId;
      if (!parentId || visited.has(parentId) || protectedRoots.has(parentId)) break;
      if (parentId === identity.rootId) { result.push(info); break; }
      const parent = byId.get(parentId);
      if (!parent) break; // A closed opener is never proof of current ownership.
      visited.add(parentId);
      cursor = parent;
    }
  }
  return result;
}

export async function inspectPageTargets(cdpEndpoint) {
  const response = await fetch(`${cdpEndpoint}/json/version`);
  if (!response.ok) throw new Error(`CDP version failed: HTTP ${response.status}`);
  const { webSocketDebuggerUrl } = await response.json();
  if (!webSocketDebuggerUrl) throw new Error("CDP browser socket unavailable");
  const socket = new WebSocket(webSocketDebuggerUrl);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Target.getTargets timed out")), 5_000);
      socket.onerror = () => { clearTimeout(timer); reject(new Error("CDP browser socket failed")); };
      socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
      socket.onmessage = event => {
        try {
          const reply = JSON.parse(String(event.data));
          if (reply.id !== 1) return;
          clearTimeout(timer);
          if (reply.error) throw new Error(reply.error.message ?? "Target.getTargets failed");
          resolve((reply.result?.targetInfos ?? []).filter(info => info.type === "page").map(info => ({ id: info.targetId, type: info.type, url: info.url, openerId: info.openerId, openerFrameId: info.openerFrameId })));
        } catch (error) { clearTimeout(timer); reject(error); }
      };
    });
  } finally { socket.close(); }
}
