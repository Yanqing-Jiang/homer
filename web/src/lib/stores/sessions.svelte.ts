/**
 * Shared session store — single source of truth for session list, selection, and unread state.
 * Consumed by both +page.svelte and sessions/+page.svelte.
 */
import * as api from '$lib/api/client';

// Session list state
let sessions = $state<api.ChatSession[]>([]);
let loading = $state(false);
let pollInterval: ReturnType<typeof setInterval> | null = null;

// Current selection
let currentSessionId = $state<string | null>(null);
let currentSessionName = $state('New Session');

export function getSessions(): api.ChatSession[] {
	return sessions;
}

export function isLoading(): boolean {
	return loading;
}

export function getCurrentSessionId(): string | null {
	return currentSessionId;
}

export function getCurrentSessionName(): string {
	return currentSessionName;
}

export function setCurrentSession(id: string | null, name: string = 'New Session') {
	currentSessionId = id;
	currentSessionName = name;
}

export async function loadSessions(options?: { limit?: number; includeArchived?: boolean }): Promise<void> {
	try {
		loading = true;
		const result = await api.listSessions({
			limit: options?.limit ?? 10,
			includeArchived: options?.includeArchived,
		});
		sessions = result.sessions;
	} catch (e) {
		console.error('Failed to load sessions:', e);
	} finally {
		loading = false;
	}
}

export async function markRead(sessionId: string): Promise<void> {
	try {
		await api.markSessionRead(sessionId);
		// Optimistically update local state
		sessions = sessions.map(s =>
			s.id === sessionId ? { ...s, hasUnread: false } : s
		);
	} catch (e) {
		console.error('Failed to mark session read:', e);
	}
}

export async function renameSession(id: string, name: string): Promise<void> {
	await api.updateSession(id, { name });
	sessions = sessions.map(s => s.id === id ? { ...s, name } : s);
	if (currentSessionId === id) {
		currentSessionName = name;
	}
}

export async function deleteSession(id: string): Promise<void> {
	await api.deleteSession(id).catch(e => {
		if (!e.message?.includes('404')) throw e;
	});
	sessions = sessions.filter(s => s.id !== id);
}

export function updateSessionInList(session: Partial<api.ChatSession> & { id: string }): void {
	sessions = sessions.map(s => s.id === session.id ? { ...s, ...session } : s);
}

/** Start 5s background polling. Call stopPolling() to clean up. */
export function startPolling(): void {
	if (pollInterval) return;
	pollInterval = setInterval(() => {
		if (!document.hidden) loadSessions();
	}, 5000);
}

export function stopPolling(): void {
	if (pollInterval) {
		clearInterval(pollInterval);
		pollInterval = null;
	}
}

// Session-level SSE
let sseSubscription: { abort: () => void } | null = null;

/** Subscribe to real-time session events via SSE. Falls back to polling on failure. */
export function startSSE(): void {
	if (sseSubscription) return;
	sseSubscription = api.subscribeToSessionEvents({
		onEvent: (_event) => {
			// On any session event, refresh the session list to get latest state
			// This is simpler than trying to apply deltas locally
			loadSessions();
		},
		onConnected: () => {
			// SSE connected — we can reduce polling frequency
			if (pollInterval) {
				clearInterval(pollInterval);
				// Keep a slow heartbeat poll as safety net (30s)
				pollInterval = setInterval(() => {
					if (!document.hidden) loadSessions();
				}, 30000);
			}
		},
		onError: () => {
			// SSE failed — ensure polling is active at 5s
			if (!pollInterval) startPolling();
		},
	});
}

export function stopSSE(): void {
	if (sseSubscription) {
		sseSubscription.abort();
		sseSubscription = null;
	}
}

/** Check if a session has an active run */
export function hasActiveRun(sessionId: string): boolean {
	const session = sessions.find(s => s.id === sessionId);
	return session?.activeRunId != null;
}

export const sessionStore = {
	get sessions() { return sessions; },
	get loading() { return loading; },
	get currentSessionId() { return currentSessionId; },
	get currentSessionName() { return currentSessionName; },
	setCurrentSession,
	loadSessions,
	markRead,
	renameSession,
	deleteSession,
	updateSessionInList,
	startPolling,
	stopPolling,
	startSSE,
	stopSSE,
	hasActiveRun,
};
