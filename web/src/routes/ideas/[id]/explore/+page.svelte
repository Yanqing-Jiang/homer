<script lang="ts">
	import { page } from '$app/stores';
	import { onMount, onDestroy } from 'svelte';
	import * as api from '$lib/api/client';
	import { useAuth } from '$lib/hooks/useAuth.svelte';
	import { AuthOverlay } from '$lib/components';
	import ChatMessages from '$lib/components/ChatMessages.svelte';
	import ChatInput from '$lib/components/ChatInput.svelte';
	import { renderMarkdown, formatTime } from '$lib/utils/markdown';
	import { toast } from '$lib/stores/toasts.svelte';

	const auth = useAuth();

	let ideaId = $derived($page.params.id);
	let idea = $state<api.Idea | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	// Chat state
	let sessionId = $state<string | null>(null);
	let threadId = $state<string | null>(null);
	let messages = $state<Array<{ id?: string; role: 'user' | 'assistant'; content: string; timestamp: Date }>>([]);
	let isStreaming = $state(false);
	let streamingContent = $state('');
	let streamingSteps = $state<Array<api.StepEvent & { startedAt: number; completed: boolean }>>([]);
	let currentAbort = $state<{ abort: () => void } | null>(null);
	let chatInput = $state('');
	let knownMessageIds = $state<Set<string>>(new Set());

	// Thread SSE subscription
	let threadSubscription: { abort: () => void } | null = null;

	onMount(async () => {
		if (!auth.isAuthorized) return;
		await loadIdea();
	});

	onDestroy(() => {
		threadSubscription?.abort();
	});

	async function loadIdea() {
		loading = true;
		try {
			idea = await api.getIdea(ideaId);

			// Start or resume exploration
			const result = await api.startIdeaExploration(ideaId);
			sessionId = result.sessionId;
			threadId = result.threadId;

			// Load thread messages
			const thread = await api.getThread(result.threadId);
			const displayMessages = thread.messages.filter(m => m.role !== 'system');
			knownMessageIds = new Set(displayMessages.map(m => m.id));
			messages = displayMessages.map(m => ({
				id: m.id,
				role: m.role as 'user' | 'assistant',
				content: m.content,
				timestamp: m.createdAt ? new Date(m.createdAt) : new Date(),
			}));

			// Restore active run steps
			if (thread.activeRun && thread.activeRun.status === 'running') {
				streamingSteps = thread.activeRun.events.map((e: api.RunEvent) => ({
					type: e.kind as 'tool_use' | 'tool_result' | 'thinking',
					id: e.payloadJson ? JSON.parse(e.payloadJson).toolId : undefined,
					label: e.label ?? '',
					labelDone: e.labelDone ?? '',
					startedAt: new Date(e.createdAt).getTime(),
					completed: e.kind === 'tool_result',
				}));
				isStreaming = true;
			}

			// If new exploration (no messages beyond system + greeting), auto-trigger
			if (!result.resumed && displayMessages.length <= 1) {
				await sendMessage('Go');
			}

			// Subscribe to thread SSE
			subscribeToThread(result.threadId);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load idea';
			toast.error(error);
		} finally {
			loading = false;
		}
	}

	function subscribeToThread(tId: string) {
		threadSubscription?.abort();
		threadSubscription = api.subscribeToThread(tId, {
			onMessage: (message) => {
				if (message.id && knownMessageIds.has(message.id)) return;
				if (message.id) knownMessageIds.add(message.id);
				if (isStreaming) return;
				messages = [...messages, {
					id: message.id,
					role: message.role as 'user' | 'assistant',
					content: message.content,
					timestamp: new Date(message.createdAt),
				}];
			}
		});
	}

	async function sendMessage(content: string) {
		if (!threadId || !sessionId || isStreaming) return;

		const userMessage = { role: 'user' as const, content, timestamp: new Date() };
		messages = [...messages, userMessage];
		chatInput = '';
		isStreaming = true;
		streamingContent = '';
		streamingSteps = [];

		try {
			const stream = api.streamMessage(threadId, content, {
				onStart: (data) => {
					if (data.userMessageId) knownMessageIds.add(data.userMessageId);
				},
				onDelta: (delta) => {
					streamingContent += delta.content;
				},
				onStep: (step) => {
					const existing = streamingSteps.find(s => s.id === step.id && s.type === step.type);
					if (existing) {
						existing.completed = step.type === 'tool_result';
					} else {
						streamingSteps = [...streamingSteps, {
							...step,
							startedAt: Date.now(),
							completed: step.type === 'tool_result',
						}];
					}
				},
				onComplete: (result) => {
					if (result.messageId) knownMessageIds.add(result.messageId);
					messages = [...messages, {
						id: result.messageId,
						role: 'assistant',
						content: streamingContent,
						timestamp: new Date(),
					}];
					isStreaming = false;
					streamingContent = '';
					streamingSteps = [];
				},
				onError: (err) => {
					toast.error(`Error: ${err.message}`);
					isStreaming = false;
				},
			});

			currentAbort = stream;
		} catch (e) {
			toast.error('Failed to send message');
			isStreaming = false;
		}
	}

	function handleSend() {
		if (chatInput.trim()) {
			sendMessage(chatInput.trim());
		}
	}
</script>

{#if !auth.isAuthorized}
	<AuthOverlay />
{:else if loading}
	<div class="loading-container">
		<div class="spinner"></div>
		<p>Loading idea exploration...</p>
	</div>
{:else if error}
	<div class="error-container">
		<p>{error}</p>
		<a href="/ideas">Back to Ideas</a>
	</div>
{:else}
	<div class="explore-layout">
		<div class="explore-sidebar">
			<a href="/ideas" class="back-link">&larr; Back to Ideas</a>
			{#if idea}
				<h2 class="idea-title">{idea.title}</h2>
				<div class="idea-meta">
					<span class="status-badge">{idea.status}</span>
					{#if idea.source}<span class="source">{idea.source}</span>{/if}
				</div>
				{#if idea.content}
					<div class="idea-content">{idea.content.slice(0, 300)}{idea.content.length > 300 ? '...' : ''}</div>
				{/if}
				<div class="idea-actions">
					<a href="/ideas" class="action-btn">Back to list</a>
				</div>
			{/if}
		</div>

		<div class="explore-chat">
			<ChatMessages
				{messages}
				{isStreaming}
				{streamingContent}
				steps={streamingSteps}
				{renderMarkdown}
				{formatTime}
			/>

			<div class="chat-input-area">
				<textarea
					bind:value={chatInput}
					placeholder="Ask about this idea..."
					onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
					disabled={isStreaming}
					rows="2"
				></textarea>
				<button onclick={handleSend} disabled={isStreaming || !chatInput.trim()}>
					{isStreaming ? 'Thinking...' : 'Send'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.explore-layout {
		display: grid;
		grid-template-columns: 300px 1fr;
		height: 100vh;
	}

	.explore-sidebar {
		padding: 20px;
		border-right: 1px solid #e0e0e0;
		overflow-y: auto;
		background: #f9f9f9;
	}

	.back-link {
		font-size: 13px;
		color: #0078d4;
		text-decoration: none;
		display: block;
		margin-bottom: 16px;
	}

	.idea-title {
		font-size: 18px;
		font-weight: 600;
		margin: 0 0 12px;
	}

	.idea-meta {
		display: flex;
		gap: 8px;
		margin-bottom: 12px;
	}

	.status-badge {
		font-size: 11px;
		padding: 2px 8px;
		border-radius: 12px;
		background: #e8f4fc;
		color: #0078d4;
	}

	.source {
		font-size: 11px;
		color: #666;
	}

	.idea-content {
		font-size: 13px;
		color: #333;
		line-height: 1.5;
		margin-bottom: 16px;
	}

	.idea-actions {
		display: flex;
		gap: 8px;
	}

	.action-btn {
		font-size: 12px;
		padding: 6px 12px;
		border: 1px solid #d0d0d0;
		border-radius: 4px;
		text-decoration: none;
		color: #333;
	}

	.explore-chat {
		display: flex;
		flex-direction: column;
		height: 100vh;
	}

	.chat-input-area {
		display: flex;
		gap: 8px;
		padding: 12px 20px;
		border-top: 1px solid #e0e0e0;
	}

	.chat-input-area textarea {
		flex: 1;
		padding: 8px 12px;
		border: 1px solid #d0d0d0;
		border-radius: 4px;
		font-size: 13px;
		resize: none;
	}

	.chat-input-area button {
		padding: 8px 16px;
		background: #0078d4;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-size: 13px;
	}

	.chat-input-area button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.loading-container, .error-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100vh;
		gap: 12px;
	}

	.spinner {
		width: 24px;
		height: 24px;
		border: 3px solid #e0e0e0;
		border-top-color: #0078d4;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	@media (max-width: 768px) {
		.explore-layout {
			grid-template-columns: 1fr;
		}
		.explore-sidebar {
			display: none;
		}
	}
</style>
