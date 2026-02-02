import { get } from 'svelte/store';
import { session } from '$lib/supabase';

// Base URL for the Homer daemon API
const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';

/**
 * Get auth headers with Supabase JWT token
 */
function getAuthHeaders(): HeadersInit {
	const currentSession = get(session);
	const headers: HeadersInit = {
		'Content-Type': 'application/json'
	};

	if (currentSession?.access_token) {
		headers['Authorization'] = `Bearer ${currentSession.access_token}`;
	}

	return headers;
}

// Event emitter for auth state changes
type AuthEventHandler = () => void;
const authExpiredHandlers: AuthEventHandler[] = [];

export function onAuthExpired(handler: AuthEventHandler): () => void {
	authExpiredHandlers.push(handler);
	return () => {
		const index = authExpiredHandlers.indexOf(handler);
		if (index !== -1) authExpiredHandlers.splice(index, 1);
	};
}

function emitAuthExpired() {
	authExpiredHandlers.forEach(handler => handler());
}

/**
 * Generic fetch wrapper with auth
 * Handles 401 responses by emitting auth:expired event
 */
async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
	const url = `${API_BASE}${path}`;
	const headers = {
		...getAuthHeaders(),
		...(options.headers || {})
	};

	const response = await fetch(url, {
		...options,
		headers
	});

	// Handle 401 - token expired or invalid
	if (response.status === 401) {
		emitAuthExpired();
		throw new Error('Session expired. Please sign in again.');
	}

	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: 'Request failed' }));
		throw new Error(error.error || error.message || `HTTP ${response.status}`);
	}

	// Handle 204 No Content
	if (response.status === 204) {
		return undefined as T;
	}

	// Safely parse JSON response, handling empty bodies
	const text = await response.text();
	if (!text || text.trim() === '') {
		// Empty response body - return undefined or throw based on context
		// This handles cases where the backend returns 200 OK with no body
		console.warn(`Empty response body for ${path}`);
		return undefined as T;
	}

	try {
		return JSON.parse(text) as T;
	} catch (e) {
		// Log the problematic response for debugging
		console.error(`Failed to parse JSON response for ${path}:`, text.substring(0, 200));
		throw new Error(`Invalid JSON response from server: ${(e as Error).message}`);
	}
}

// ============================================
// Chat Sessions API
// ============================================

export interface ChatSession {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	archivedAt: string | null;
	threadCount?: number;
	activeThreadCount?: number;
}

export interface Thread {
	id: string;
	chatSessionId: string;
	title: string | null;
	provider: 'claude' | 'chatgpt' | 'gemini';
	model: string | null;
	status: 'active' | 'expired' | 'archived';
	externalSessionId: string | null;
	parentThreadId: string | null;
	branchPointMessageId: string | null;
	lastMessageAt: string | null;
	createdAt: string;
	messageCount?: number;
}

export interface ThreadMessage {
	id: string;
	threadId: string;
	role: 'user' | 'assistant' | 'system';
	content: string;
	metadata: Record<string, unknown> | null;
	createdAt: string;
}

export interface ThreadLink {
	threadId: string;
	linkType: 'idea' | 'plan';
	linkId: string;
	createdAt: string;
}

// List sessions
export async function listSessions(options?: {
	includeArchived?: boolean;
	limit?: number;
	cursor?: string;
}): Promise<{ sessions: ChatSession[]; nextCursor: string | null }> {
	const params = new URLSearchParams();
	if (options?.includeArchived) params.set('includeArchived', 'true');
	if (options?.limit) params.set('limit', String(options.limit));
	if (options?.cursor) params.set('cursor', options.cursor);

	const query = params.toString();
	const result = await apiFetch<{ sessions: ChatSession[]; nextCursor: string | null } | undefined>(`/api/chat-sessions${query ? `?${query}` : ''}`);
	// Handle empty response gracefully
	return result ?? { sessions: [], nextCursor: null };
}

// Create session
export async function createSession(name: string): Promise<ChatSession> {
	return apiFetch('/api/chat-sessions', {
		method: 'POST',
		body: JSON.stringify({ name })
	});
}

// Get session with threads
export async function getSession(id: string): Promise<ChatSession & { threads: Thread[] }> {
	return apiFetch(`/api/chat-sessions/${id}`);
}

// Update session
export async function updateSession(
	id: string,
	updates: { name?: string; archived?: boolean }
): Promise<ChatSession> {
	return apiFetch(`/api/chat-sessions/${id}`, {
		method: 'PATCH',
		body: JSON.stringify(updates)
	});
}

// Delete session
export async function deleteSession(id: string): Promise<void> {
	return apiFetch(`/api/chat-sessions/${id}`, { method: 'DELETE' });
}

// ============================================
// Threads API
// ============================================

// List threads for a session
export async function listThreads(sessionId: string): Promise<{ threads: Thread[] }> {
	const result = await apiFetch<{ threads: Thread[] } | undefined>(`/api/chat-sessions/${sessionId}/threads`);
	return result ?? { threads: [] };
}

// Create thread
export async function createThread(
	sessionId: string,
	options: {
		title?: string;
		provider: 'claude' | 'chatgpt' | 'gemini';
		model?: string;
		parentThreadId?: string;
		branchPointMessageId?: string;
	}
): Promise<Thread> {
	return apiFetch(`/api/chat-sessions/${sessionId}/threads`, {
		method: 'POST',
		body: JSON.stringify(options)
	});
}

// Get thread with messages
export async function getThread(
	id: string
): Promise<Thread & { messages: ThreadMessage[]; links: ThreadLink[] }> {
	return apiFetch(`/api/threads/${id}`);
}

// Update thread
export async function updateThread(
	id: string,
	updates: { title?: string; status?: 'active' | 'expired' | 'archived' }
): Promise<Thread> {
	return apiFetch(`/api/threads/${id}`, {
		method: 'PATCH',
		body: JSON.stringify(updates)
	});
}

// ============================================
// Messages API
// ============================================

// List messages
export async function listMessages(
	threadId: string,
	options?: { limit?: number; beforeId?: string }
): Promise<{ messages: ThreadMessage[] }> {
	const params = new URLSearchParams();
	if (options?.limit) params.set('limit', String(options.limit));
	if (options?.beforeId) params.set('beforeId', options.beforeId);

	const query = params.toString();
	const result = await apiFetch<{ messages: ThreadMessage[] } | undefined>(`/api/threads/${threadId}/messages${query ? `?${query}` : ''}`);
	return result ?? { messages: [] };
}

// Create message (non-streaming)
export async function createMessage(
	threadId: string,
	content: string,
	options?: { role?: 'user' | 'assistant' | 'system'; metadata?: Record<string, unknown> }
): Promise<ThreadMessage> {
	return apiFetch(`/api/threads/${threadId}/messages`, {
		method: 'POST',
		body: JSON.stringify({ content, ...options })
	});
}

// ============================================
// Scheduled Jobs API
// ============================================

export interface ScheduledJob {
	id: string;
	name: string;
	cron: string;
	cronHuman: string;
	lane: string;
	enabled: boolean;
	timeout: number | null;
	model: string | null;
	lastRun: string | null;
	lastSuccess: string | null;
	consecutiveFailures: number;
	nextRuns: string[];
}

export interface JobRun {
	id: string;
	startedAt: string;
	completedAt: string | null;
	success: boolean;
	output?: string;
	error?: string;
	exitCode?: number;
	durationMs?: number | null;
}

export interface ScheduledJobDetail extends ScheduledJob {
	query?: string;
	state?: {
		lastRunAt: string | null;
		lastSuccessAt: string | null;
		consecutiveFailures: number;
	};
	history: JobRun[];
}

export interface CalendarEvent {
	jobId: string;
	jobName: string;
	date: string;
	time: string;
	enabled: boolean;
}

// List all scheduled jobs
export async function listScheduledJobs(): Promise<{ jobs: ScheduledJob[] }> {
	const result = await apiFetch<{ jobs: ScheduledJob[] } | undefined>('/api/jobs/scheduled');
	return result ?? { jobs: [] };
}

// Get job details with history
export async function getScheduledJob(id: string): Promise<ScheduledJobDetail> {
	return apiFetch(`/api/jobs/scheduled/${id}`);
}

// Update job
export async function updateScheduledJob(
	id: string,
	updates: { enabled?: boolean; cron?: string; query?: string; name?: string; scheduledDate?: string }
): Promise<ScheduledJob & { message: string }> {
	return apiFetch(`/api/jobs/scheduled/${id}`, {
		method: 'PATCH',
		body: JSON.stringify(updates)
	});
}

// Trigger job immediately
export async function triggerScheduledJob(
	id: string
): Promise<{ success: boolean; jobId: string; jobName: string }> {
	return apiFetch(`/api/jobs/scheduled/${id}/run`, { method: 'POST' });
}

// Get job run history
export async function getJobHistory(
	id: string,
	options?: { limit?: number }
): Promise<{ history: JobRun[] }> {
	const params = new URLSearchParams();
	if (options?.limit) params.set('limit', String(options.limit));

	const query = params.toString();
	const result = await apiFetch<{ history: JobRun[] } | undefined>(`/api/jobs/scheduled/${id}/history${query ? `?${query}` : ''}`);
	return result ?? { history: [] };
}

// Get calendar events
export async function getJobCalendar(options?: {
	start?: string;
	end?: string;
}): Promise<{ start: string; end: string; events: CalendarEvent[] }> {
	const params = new URLSearchParams();
	if (options?.start) params.set('start', options.start);
	if (options?.end) params.set('end', options.end);

	const query = params.toString();
	const result = await apiFetch<{ start: string; end: string; events: CalendarEvent[] } | undefined>(`/api/jobs/calendar${query ? `?${query}` : ''}`);
	return result ?? { start: options?.start || '', end: options?.end || '', events: [] };
}

// ============================================
// Ideas API
// ============================================

export interface Idea {
	id: string;
	title: string;
	status: 'draft' | 'researching' | 'review' | 'planning' | 'execution' | 'archived';
	source: string;
	content: string;
	context?: string | null;
	link?: string | null;
	notes?: string | null;
	tags?: string[];
	timestamp?: string;
	createdAt?: string;
	filePath?: string;
	linkedThreadId?: string | null;
}

// List ideas
export async function listIdeas(options?: {
	status?: string;
	limit?: number;
}): Promise<{ ideas: Idea[]; migrated: boolean }> {
	const params = new URLSearchParams();
	if (options?.status) params.set('status', options.status);
	if (options?.limit) params.set('limit', String(options.limit));

	const query = params.toString();
	const result = await apiFetch<{ ideas: Idea[]; migrated: boolean } | undefined>(`/api/ideas${query ? `?${query}` : ''}`);
	return result ?? { ideas: [], migrated: false };
}

// Get single idea
export async function getIdea(id: string): Promise<Idea> {
	return apiFetch(`/api/ideas/${id}`);
}

// Create idea
export async function createIdea(data: {
	title: string;
	content: string;
	source?: string;
	context?: string;
	tags?: string[];
	link?: string;
}): Promise<{ id: string; filePath: string }> {
	return apiFetch('/api/ideas', {
		method: 'POST',
		body: JSON.stringify(data)
	});
}

// Update idea
export async function updateIdea(
	id: string,
	updates: {
		status?: string;
		title?: string;
		notes?: string;
		content?: string;
		context?: string;
		tags?: string[];
		link?: string;
	}
): Promise<Idea> {
	return apiFetch(`/api/ideas/${id}`, {
		method: 'PATCH',
		body: JSON.stringify(updates)
	});
}

// Delete idea
export async function deleteIdea(id: string): Promise<{ deleted: boolean; id: string }> {
	return apiFetch(`/api/ideas/${id}`, { method: 'DELETE' });
}

// Start research on an idea (creates linked thread)
export async function startIdeaResearch(
	id: string
): Promise<{ sessionId: string; threadId: string; message: string }> {
	return apiFetch(`/api/ideas/${id}/research`, { method: 'POST' });
}

// ============================================
// Plans API
// ============================================

export interface PlanPhase {
	name: string;
	status: 'pending' | 'in_progress' | 'completed';
	tasks: Array<{ text: string; completed: boolean }>;
}

export interface Plan {
	id: string;
	title: string;
	description?: string | null;
	currentPhase?: string | null;
	status: string;
	phases: PlanPhase[];
	filePath?: string;
	createdAt?: string;
	updatedAt?: string;
	completedTasks?: number;
	totalTasks?: number;
}

export interface PlanDetail extends Plan {
	threads?: Thread[];
}

// List plans
export async function listPlans(options?: {
	status?: string;
	limit?: number;
}): Promise<{ plans: Plan[] }> {
	const params = new URLSearchParams();
	if (options?.status) params.set('status', options.status);
	if (options?.limit) params.set('limit', String(options.limit));

	const query = params.toString();
	const result = await apiFetch<{ plans: Plan[] } | undefined>(`/api/plans${query ? `?${query}` : ''}`);
	return result ?? { plans: [] };
}

// Get single plan with full details
export async function getPlan(id: string): Promise<PlanDetail> {
	return apiFetch(`/api/plans/${id}`);
}

// Toggle task completion
export async function togglePlanTask(
	planId: string,
	taskText: string,
	completed: boolean
): Promise<Plan> {
	return apiFetch(`/api/plans/${planId}/task`, {
		method: 'PATCH',
		body: JSON.stringify({ taskText, completed })
	});
}

// Update plan (full edit)
export async function updatePlan(
	planId: string,
	updates: {
		title?: string;
		description?: string;
		status?: string;
		currentPhase?: string;
		phases?: PlanPhase[];
	}
): Promise<Plan> {
	return apiFetch(`/api/plans/${planId}`, {
		method: 'PATCH',
		body: JSON.stringify(updates)
	});
}

// Create work thread for a plan
export async function createPlanWorkThread(
	planId: string
): Promise<{ sessionId: string; threadId: string; message: string }> {
	return apiFetch(`/api/plans/${planId}/work`, { method: 'POST' });
}

// ============================================
// Claude Code History API
// ============================================

export interface ClaudeCodeSession {
	sessionId: string;
	project: string;
	projectName: string;
	startTime: number;
	endTime: number;
	formattedStart: string;
	formattedEnd: string;
	promptCount: number;
	firstPrompt: string;
	lastPrompt: string;
}

export interface ClaudeCodePrompt {
	display: string;
	timestamp: number;
	formattedTime: string;
}

export interface ClaudeCodeSessionDetail extends ClaudeCodeSession {
	prompts: ClaudeCodePrompt[];
}

// List Claude Code sessions
export async function listClaudeHistory(options?: {
	limit?: number;
}): Promise<{ sessions: ClaudeCodeSession[]; total: number }> {
	const params = new URLSearchParams();
	if (options?.limit) params.set('limit', String(options.limit));

	const query = params.toString();
	const result = await apiFetch<{ sessions: ClaudeCodeSession[]; total: number } | undefined>(`/api/claude-history${query ? `?${query}` : ''}`);
	return result ?? { sessions: [], total: 0 };
}

// Get Claude Code session detail
export async function getClaudeHistorySession(sessionId: string): Promise<ClaudeCodeSessionDetail> {
	return apiFetch(`/api/claude-history/${sessionId}`);
}

// ============================================
// Uploads API
// ============================================

export interface Upload {
	id: string;
	filename: string;
	path: string;
	mimeType: string;
	size: number;
	sessionId: string;
	createdAt: string;
}

// Upload file
export async function uploadFile(
	file: File,
	sessionId: string
): Promise<Upload> {
	const currentSession = get(session);
	const formData = new FormData();
	formData.append('file', file);
	formData.append('sessionId', sessionId);

	const response = await fetch(`${API_BASE}/api/uploads`, {
		method: 'POST',
		headers: {
			...(currentSession?.access_token
				? { Authorization: `Bearer ${currentSession.access_token}` }
				: {})
		},
		body: formData
	});

	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: 'Upload failed' }));
		throw new Error(error.error || 'Upload failed');
	}

	// Handle empty response for uploads too
	const text = await response.text();
	if (!text || text.trim() === '') {
		throw new Error('Upload succeeded but received empty response');
	}

	try {
		return JSON.parse(text) as Upload;
	} catch (e) {
		throw new Error(`Invalid JSON response from upload: ${(e as Error).message}`);
	}
}

// List uploads for session
export async function listUploads(sessionId: string): Promise<{ uploads: Upload[] }> {
	const result = await apiFetch<{ uploads: Upload[] } | undefined>(`/api/uploads/${sessionId}`);
	return result ?? { uploads: [] };
}

// Delete upload
export async function deleteUpload(sessionId: string, uploadId: string): Promise<{ deleted: boolean }> {
	const result = await apiFetch<{ deleted: boolean } | undefined>(`/api/uploads/${sessionId}/${uploadId}`, { method: 'DELETE' });
	return result ?? { deleted: false };
}

// ============================================
// SSE Streaming
// ============================================

export interface StreamCallbacks {
	onStart?: (data: { userMessageId: string }) => void;
	onDelta?: (data: { content: string }) => void;
	onComplete?: (data: { messageId: string; exitCode?: number }) => void;
	onError?: (data: { message: string; recoverable: boolean; code?: string }) => void;
}

export interface StreamOptions {
	attachments?: string[];
	sessionId?: string;
}

/**
 * Parse SSE stream properly handling event types and multi-line data
 */
interface SSEEvent {
	event: string;
	data: string;
}

function parseSSEStream(buffer: string): { events: SSEEvent[]; remaining: string } {
	const events: SSEEvent[] = [];
	const blocks = buffer.split('\n\n');
	const remaining = blocks.pop() || '';

	for (const block of blocks) {
		if (!block.trim()) continue;

		let eventType = 'message';
		const dataLines: string[] = [];

		for (const line of block.split('\n')) {
			if (line.startsWith('event:')) {
				eventType = line.slice(6).trim();
			} else if (line.startsWith('data:')) {
				dataLines.push(line.slice(5).trim());
			}
		}

		if (dataLines.length > 0) {
			events.push({
				event: eventType,
				data: dataLines.join('\n')
			});
		}
	}

	return { events, remaining };
}

/**
 * Send a message and stream the response via SSE
 * Returns an object with abort function for cleanup
 */
export function streamMessage(
	threadId: string,
	content: string,
	callbacks: StreamCallbacks,
	options?: StreamOptions
): { abort: () => void } {
	const controller = new AbortController();
	const currentSession = get(session);
	let isAborted = false;
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

	const url = `${API_BASE}/api/threads/${threadId}/stream`;

	// We need to POST with body, so we use fetch with ReadableStream
	fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(currentSession?.access_token
				? { Authorization: `Bearer ${currentSession.access_token}` }
				: {})
		},
		body: JSON.stringify({
			content,
			attachments: options?.attachments,
			sessionId: options?.sessionId
		}),
		signal: controller.signal
	})
		.then(async (response) => {
			// Handle 401 - token expired
			if (response.status === 401) {
				emitAuthExpired();
				callbacks.onError?.({ message: 'Session expired. Please sign in again.', recoverable: false, code: 'AUTH_EXPIRED' });
				return;
			}

			if (!response.ok) {
				const error = await response.json().catch(() => ({ error: 'Stream failed' }));
				callbacks.onError?.({ message: error.error || 'Stream failed', recoverable: false });
				return;
			}

			reader = response.body?.getReader() || null;
			if (!reader) {
				callbacks.onError?.({ message: 'No response body', recoverable: false });
				return;
			}

			const decoder = new TextDecoder();
			let buffer = '';

			try {
				while (!isAborted) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const { events, remaining } = parseSSEStream(buffer);
					buffer = remaining;

					for (const sseEvent of events) {
						try {
							const parsed = JSON.parse(sseEvent.data);

							// Route based on event type or infer from data shape
							switch (sseEvent.event) {
								case 'start':
									callbacks.onStart?.(parsed);
									break;
								case 'delta':
									callbacks.onDelta?.(parsed);
									break;
								case 'complete':
									callbacks.onComplete?.(parsed);
									break;
								case 'error':
									callbacks.onError?.(parsed);
									break;
								default:
									// Fallback: infer from data shape
									if ('userMessageId' in parsed) {
										callbacks.onStart?.(parsed);
									} else if ('content' in parsed && !('messageId' in parsed)) {
										callbacks.onDelta?.(parsed);
									} else if ('messageId' in parsed) {
										callbacks.onComplete?.(parsed);
									} else if ('message' in parsed && 'recoverable' in parsed) {
										callbacks.onError?.(parsed);
									}
							}
						} catch {
							// Ignore parse errors for individual events
						}
					}
				}
			} finally {
				// Ensure reader is released
				reader?.releaseLock();
			}
		})
		.catch((error) => {
			if (error.name !== 'AbortError' && !isAborted) {
				callbacks.onError?.({ message: error.message, recoverable: false });
			}
		});

	return {
		abort: () => {
			isAborted = true;
			controller.abort();
			// Cancel and release the reader if it exists
			reader?.cancel().catch(() => {});
		}
	};
}
