/**
 * Shared chat store — manages thread state, messages, streaming, and run progress.
 * Used by both +page.svelte and sessions/+page.svelte.
 */
import * as api from '$lib/api/client';
import { buildStreamingStepsFromRunEvents } from '$lib/utils/run-steps';

export interface DisplayMessage {
	id?: string;
	role: 'user' | 'assistant';
	content: string;
	timestamp: Date;
}

export interface DisplayStep {
	type: string;
	id?: string;
	label: string;
	labelDone: string;
	startedAt: number;
	completed: boolean;
}

// Thread state
let threadId = $state<string | null>(null);
let messages = $state<DisplayMessage[]>([]);
let knownMessageIds = $state<Set<string>>(new Set());

// Streaming state
let isStreaming = $state(false);
let streamingContent = $state('');
let streamingSteps = $state<DisplayStep[]>([]);
let currentAbort = $state<{ abort: () => void } | null>(null);

export function getThreadId(): string | null {
	return threadId;
}

export function getMessages(): DisplayMessage[] {
	return messages;
}

export function isCurrentlyStreaming(): boolean {
	return isStreaming;
}

export function getStreamingContent(): string {
	return streamingContent;
}

export function getStreamingSteps(): DisplayStep[] {
	return streamingSteps;
}

export function setThreadId(id: string | null) {
	threadId = id;
}

export function setMessages(msgs: DisplayMessage[]) {
	messages = msgs;
	knownMessageIds = new Set(msgs.filter(m => m.id).map(m => m.id!));
}

export function addMessage(msg: DisplayMessage) {
	if (msg.id && knownMessageIds.has(msg.id)) return;
	if (msg.id) knownMessageIds.add(msg.id);
	messages = [...messages, msg];
}

export function setStreaming(streaming: boolean) {
	isStreaming = streaming;
}

export function setStreamingContent(content: string) {
	streamingContent = content;
}

export function setStreamingSteps(steps: DisplayStep[]) {
	streamingSteps = steps;
}

export function setCurrentAbort(abort: { abort: () => void } | null) {
	currentAbort = abort;
}

export function resetStreamingState() {
	isStreaming = false;
	streamingContent = '';
	streamingSteps = [];
	currentAbort = null;
}

export function abortCurrentStream() {
	if (currentAbort) {
		currentAbort.abort();
	}
	resetStreamingState();
}

/** Load thread messages and restore active run steps */
export async function loadThread(tId: string): Promise<void> {
	const thread = await api.getThread(tId);
	const displayMessages = thread.messages.filter(m => m.role !== 'system');
	knownMessageIds = new Set(displayMessages.map(m => m.id));
	messages = displayMessages.map(m => ({
		id: m.id,
		role: m.role as 'user' | 'assistant',
		content: m.content,
		timestamp: m.createdAt ? new Date(m.createdAt) : new Date(),
	}));
	threadId = tId;

	// Restore active run step state from persisted run events
	if (thread.activeRun && thread.activeRun.status === 'running') {
		streamingSteps = buildStreamingStepsFromRunEvents(thread.activeRun.events);
		isStreaming = true;
	}
}

/** Check if a message ID is already known (for dedup) */
export function hasMessage(id: string): boolean {
	return knownMessageIds.has(id);
}

export const chatStore = {
	get threadId() { return threadId; },
	get messages() { return messages; },
	get isStreaming() { return isStreaming; },
	get streamingContent() { return streamingContent; },
	get streamingSteps() { return streamingSteps; },
	setThreadId,
	setMessages,
	addMessage,
	setStreaming,
	setStreamingContent,
	setStreamingSteps,
	setCurrentAbort,
	resetStreamingState,
	abortCurrentStream,
	loadThread,
	hasMessage,
};
