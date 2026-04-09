<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { StatusBadge, EmptyState, AuthOverlay } from '$lib/components';
	import { useAuth } from '$lib/hooks/useAuth.svelte';
	import * as api from '$lib/api/client';
	import { toast } from '$lib/stores/toasts.svelte';
	import { buildStreamingStepsFromRunEvents } from '$lib/utils/run-steps';

	const auth = useAuth();

	// Tab state
	let activeTab = $state<'homer' | 'claude-code'>('homer');

	// State
	let sessions = $state<api.ChatSession[]>([]);
	let selectedSession = $state<(api.ChatSession & { threads: api.Thread[] }) | null>(null);
	let selectedThread = $state<(api.Thread & { messages: api.ThreadMessage[] }) | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let filterStatus = $state<'all' | 'active' | 'archived'>('all');
	let searchQuery = $state('');

	// Claude Code history state
	let claudeSessions = $state<api.ClaudeCodeSession[]>([]);
	let selectedClaudeSession = $state<api.ClaudeCodeSessionDetail | null>(null);
	let claudeLoading = $state(false);

	// New session modal
	let showNewSessionModal = $state(false);
	let newSessionName = $state('');
	let creatingSession = $state(false);

	// Chat state
	let messageInput = $state('');
	let sendingMessage = $state(false);
	let streamingContent = $state('');
	let streamingSteps = $state<Array<api.StepEvent & { startedAt: number; completed: boolean }>>([]);
	let textareaRef = $state<HTMLTextAreaElement | null>(null);

	// File attachment state (client-only)
	let attachedFiles = $state<File[]>([]);
	let uploadingFiles = $state(false);
	let uploadError = $state<string | null>(null);

	// Thread live updates via SSE
	// NOT $state — must not trigger $effect re-runs
	let threadSubscription: { abort: () => void } | null = null;
	let runSubscription: { abort: () => void } | null = null;
	let activeRunId: string | null = null;

	$effect(() => {
		const tid = selectedThread?.id;
		if (!tid) return;

		const sub = api.subscribeToThread(tid, {
			onMessage: (message) => {
				if (!selectedThread || selectedThread.id !== tid) return;
				// Deduplicate by ID
				if (selectedThread.messages.some(m => m.id === message.id)) return;
				// Skip while sending to avoid clobbering optimistic updates
				if (sendingMessage) return;
				selectedThread = {
					...selectedThread,
					messages: [...selectedThread.messages, message]
				};
			}
		});
		threadSubscription = sub;
		return () => sub.abort();
	});

	onDestroy(() => {
		threadSubscription?.abort();
		threadSubscription = null;
		runSubscription?.abort();
		runSubscription = null;
	});

	function resetStreamingState() {
		streamingContent = '';
		streamingSteps = [];
		activeRunId = null;
		runSubscription?.abort();
		runSubscription = null;
	}

	function applyStreamingStep(step: api.StepEvent) {
		if (step.type === 'tool_use') {
			streamingSteps = [...streamingSteps, { ...step, startedAt: Date.now(), completed: false }];
			return;
		}

		if (step.type === 'tool_result') {
			if (step.id) {
				const existing = streamingSteps.find((s) => s.id === step.id && s.type === 'tool_use');
				if (existing) {
					streamingSteps = streamingSteps.map((s) =>
						s.id === step.id && s.type === 'tool_use'
							? {
									...s,
									completed: true,
									labelDone: step.labelDone || s.labelDone,
									preview: step.preview ?? s.preview
								}
							: s
					);
					return;
				}
			}

			streamingSteps = [
				...streamingSteps,
				{
					...step,
					type: 'tool_use',
					label: step.label || step.labelDone || 'Working...',
					labelDone: step.labelDone || step.label || 'Finished',
					startedAt: Date.now(),
					completed: true
				}
			];
			return;
		}

		if (step.type === 'thinking') {
			if (step.id) {
				const existing = streamingSteps.find((s) => s.id === step.id && s.type === 'thinking');
				if (existing) {
					streamingSteps = streamingSteps.map((s) =>
						s.id === step.id && s.type === 'thinking'
							? { ...s, ...step, completed: true, startedAt: s.startedAt }
							: s
					);
					return;
				}
			}

			streamingSteps = [...streamingSteps, { ...step, startedAt: Date.now(), completed: true }];
		}
	}

	function activityLabel(step: api.StepEvent & { completed: boolean }): string {
		if (step.type === 'thinking') {
			return step.labelDone || step.label;
		}
		return step.completed ? step.labelDone : step.label;
	}

	function activityIcon(step: api.StepEvent & { completed: boolean }): 'spark' | 'done' | 'spinner' {
		if (step.type === 'thinking') return 'spark';
		return step.completed ? 'done' : 'spinner';
	}

	async function handleRunFinished(
		runId: string,
		threadId: string,
		status: 'completed' | 'failed' | 'cancelled'
	) {
		if (!selectedThread || selectedThread.id !== threadId || activeRunId !== runId) return;

		sendingMessage = false;
		try {
			const updated = await api.getThread(threadId);
			if (selectedThread?.id === threadId) {
				selectedThread = updated;
			}
			if (status === 'failed' || status === 'cancelled') {
				const run = await api.getRun(runId);
				if (status === 'failed') {
					error = run.run.error || 'Run failed';
				} else if (status === 'cancelled') {
					error = 'Run cancelled';
				}
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to refresh thread';
		} finally {
			resetStreamingState();
		}
	}

	function startRunStream(runId: string, threadId: string) {
		if (activeRunId === runId && runSubscription) return;

		runSubscription?.abort();
		runSubscription = null;
		activeRunId = runId;

		runSubscription = api.streamRunEvents(runId, {
			onPartial: (data) => {
				if (selectedThread?.id !== threadId || activeRunId !== runId) return;
				if (data.delta) {
					streamingContent += data.delta;
				}
			},
			onStep: (data) => {
				if (selectedThread?.id !== threadId || activeRunId !== runId) return;
				applyStreamingStep(data);
			},
			onStatus: async (data) => {
				if (selectedThread?.id !== threadId || activeRunId !== runId) return;
				if (
					data.status === 'completed' ||
					data.status === 'failed' ||
					data.status === 'cancelled'
				) {
					await handleRunFinished(runId, threadId, data.status);
				}
			},
			onError: (err) => {
				if (selectedThread?.id !== threadId || activeRunId !== runId) return;
				sendingMessage = false;
				error = err.message;
				resetStreamingState();
			}
		});
	}

	// Load sessions on mount
	onMount(async () => {
		await loadSessions();
	});

	async function loadSessions() {
		loading = true;
		error = null;
		try {
			const result = await api.listSessions({
				includeArchived: filterStatus === 'archived'
			});
			sessions = result.sessions;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load sessions';
			toast.error('Failed to load sessions');
		} finally {
			loading = false;
		}
	}

	async function createSession() {
		if (!newSessionName.trim()) return;
		creatingSession = true;
		try {
			const session = await api.createSession(newSessionName.trim());
			sessions = [{ ...session, threadCount: 0, activeThreadCount: 0 }, ...sessions];
			showNewSessionModal = false;
			newSessionName = '';
			// Open the new session
			await openSession(session);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create session';
		} finally {
			creatingSession = false;
		}
	}

	async function openSession(session: api.ChatSession) {
		try {
			resetStreamingState();
			const fullSession = await api.getSession(session.id);
			selectedSession = fullSession;
			selectedThread = null;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load session';
		}
	}

	async function openThread(thread: api.Thread) {
		try {
			resetStreamingState();
			const fullThread = await api.getThread(thread.id);
			selectedThread = fullThread;
			if (
				fullThread.activeRun &&
				fullThread.activeRun.status === 'running' &&
				fullThread.activeRun.executor !== 'claude' &&
				fullThread.activeRun.executor !== 'chatgpt'
			) {
				streamingSteps = buildStreamingStepsFromRunEvents(fullThread.activeRun.events);
				startRunStream(fullThread.activeRun.id, fullThread.id);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load thread';
		}
	}

	async function createThread(
		provider: 'claude' | 'gemini' | 'codex' | 'kimi' | 'chatgpt' | 'opencode' = 'claude'
	) {
		if (!selectedSession) return;
		try {
			const thread = await api.createThread(selectedSession.id, {
				provider,
				title: `New ${provider} thread`
			});
			selectedSession = {
				...selectedSession,
				threads: [thread, ...selectedSession.threads]
			};
			await openThread(thread);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create thread';
		}
	}

	// File attachment functions
	const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
	const MAX_FILE_SIZE_MB = MAX_FILE_SIZE / 1024 / 1024;

	function openFilePicker() {
		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;
		input.onchange = (e) => {
			const files = Array.from((e.target as HTMLInputElement).files ?? []);
			const oversized = files.filter((f) => f.size > MAX_FILE_SIZE);
			if (oversized.length > 0) {
				uploadError = `Files too large (>${MAX_FILE_SIZE_MB}MB): ${oversized.map((f) => f.name).join(', ')}`;
				return;
			}
			uploadError = null;
			attachedFiles = [...attachedFiles, ...files];
		};
		input.click();
	}

	function removeFile(file: File) {
		attachedFiles = attachedFiles.filter((f) => f !== file);
	}

	function clearAllFiles() {
		attachedFiles = [];
		uploadError = null;
	}

	// Textarea auto-resize
	async function handleTextareaInput() {
		if (!textareaRef) return;
		textareaRef.style.height = 'auto';
		textareaRef.style.height = `${textareaRef.scrollHeight}px`;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			if (canSend) {
				sendMessage();
			}
		}
		if (e.key === 'Escape') {
			textareaRef?.blur();
		}
	}

	// Computed: can send message
	const canSend = $derived(
		!sendingMessage && !uploadingFiles && (messageInput.trim() || attachedFiles.length > 0)
	);

	async function sendMessage() {
		if (!selectedThread || (!messageInput.trim() && attachedFiles.length === 0) || sendingMessage) return;

		const typedContent = messageInput.trim();
		const userVisibleContent =
			typedContent || `Attached files: ${attachedFiles.map((file) => file.name).join(', ')}`;
		const executionContent = typedContent || 'Please inspect the attached file(s).';
		const threadId = selectedThread.id;
		const provider = selectedThread.provider;
		const isExecutorCommand = /^\/(gemini|codex|claude|sonnet|opus|chatgpt|kimi|open_flash|open_opus|g|x|new)\b/i.test(typedContent);
		let sessionExecutor: api.ExecutorType = 'claude';
		if (selectedSession) {
			try {
				const state = await api.getExecutorState(selectedSession.id);
				sessionExecutor = state.executor;
			} catch (err) {
				console.warn('Failed to load executor state, defaulting to Claude:', err);
			}
		}

		// Upload files first if any
		let uploadIds: string[] = [];
		let uploadPaths: string[] = [];
		const filesToUpload = [...attachedFiles];
		if (filesToUpload.length > 0 && selectedSession) {
			uploadingFiles = true;
			uploadError = null;
			try {
				for (const file of filesToUpload) {
					const upload = await api.uploadFile(file, selectedSession.id);
					uploadIds.push(upload.id);
					uploadPaths.push(upload.path);
				}
			} catch (err) {
				uploadingFiles = false;
				uploadError = err instanceof Error ? err.message : 'Failed to upload files';
				return;
			}
			uploadingFiles = false;
		}

		// Clear input and files
		const savedContent = messageInput;
		messageInput = '';
		attachedFiles = [];
		sendingMessage = true;
		resetStreamingState();

		// Reset textarea height
		if (textareaRef) {
			textareaRef.style.height = 'auto';
		}

		// Optimistically add user message
		const tempUserMessage: api.ThreadMessage = {
			id: 'temp-' + Date.now(),
			threadId: threadId,
			role: 'user',
			content: userVisibleContent,
			metadata: null,
			createdAt: new Date().toISOString()
		};

		selectedThread = {
			...selectedThread,
			messages: [...selectedThread.messages, tempUserMessage]
		};

		if (provider === 'claude' && !isExecutorCommand && sessionExecutor === 'claude') {
			api.streamMessage(
				threadId,
				executionContent,
				{
				onStart: (data) => {
					// Update temp message with real ID
					if (selectedThread && selectedThread.id === threadId) {
						selectedThread = {
							...selectedThread,
							messages: selectedThread.messages.map((m) =>
								m.id === tempUserMessage.id ? { ...m, id: data.userMessageId } : m
							)
						};
					}
				},
				onDelta: (data) => {
					streamingContent += data.content;
				},
				onComplete: async (data) => {
					sendingMessage = false;
					// Add assistant message
					if (selectedThread && selectedThread.id === threadId && streamingContent) {
						const assistantMessage: api.ThreadMessage = {
							id: data.messageId,
							threadId,
							role: 'assistant',
							content: streamingContent,
							metadata: null,
							createdAt: new Date().toISOString()
						};
						selectedThread = {
							...selectedThread,
							messages: [...selectedThread.messages, assistantMessage]
						};
					}
					streamingContent = '';
				},
				onError: (data) => {
					sendingMessage = false;

					// Handle 409 Conflict (thread busy)
					if (data.code === 'THREAD_BUSY') {
						error = 'Thread is busy. Please wait for the current response to complete.';
					} else {
						error = data.message;
					}

					// Rollback optimistic update
					if (selectedThread && selectedThread.id === threadId) {
						selectedThread = {
							...selectedThread,
							messages: selectedThread.messages.filter((m) => m.id !== tempUserMessage.id)
						};
					}

					// Restore message input so user can retry
					messageInput = savedContent;
					if (data.code === 'SESSION_EXPIRED' && selectedThread && selectedThread.id === threadId) {
						selectedThread = { ...selectedThread, status: 'expired' };
					}
					streamingContent = '';
				}
			},
			{ attachments: uploadIds, sessionId: selectedSession?.id }
			);
			return;
		}

		// Non-Claude executors: run + status events
		try {
			const result = await api.executeMessage(
				threadId,
				executionContent,
				uploadPaths.length > 0 ? uploadPaths : undefined
			);
			if (result.userMessageId && selectedThread && selectedThread.id === threadId) {
				selectedThread = {
					...selectedThread,
					messages: selectedThread.messages.map((m) =>
						m.id === tempUserMessage.id ? { ...m, id: result.userMessageId! } : m
					)
				};
			}
			startRunStream(result.runId, threadId);
		} catch (err) {
			sendingMessage = false;
			resetStreamingState();
			error = err instanceof Error ? err.message : 'Execution failed';
			toast.error('Execution failed');
			messageInput = typedContent;
			attachedFiles = filesToUpload;
		}
	}

	function closeSession() {
		resetStreamingState();
		selectedSession = null;
		selectedThread = null;
	}

	function closeThread() {
		resetStreamingState();
		selectedThread = null;
	}

	// Filtered sessions
	const filteredSessions = $derived(() => {
		return sessions.filter((session) => {
			const matchesStatus =
				filterStatus === 'all' ||
				(filterStatus === 'archived' ? session.archivedAt !== null : session.archivedAt === null);
			const matchesSearch =
				!searchQuery || session.name.toLowerCase().includes(searchQuery.toLowerCase());
			return matchesStatus && matchesSearch;
		});
	});

	const statusCounts = $derived(() => {
		const counts: Record<string, number> = { all: sessions.length };
		counts.active = sessions.filter((s) => !s.archivedAt).length;
		counts.archived = sessions.filter((s) => s.archivedAt).length;
		return counts;
	});

	function formatRelativeTime(timestamp: string): string {
		const date = new Date(timestamp);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMins / 60);
		const diffDays = Math.floor(diffHours / 24);

		if (diffMins < 1) return 'Just now';
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;
		return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	}

	function formatMessageTime(timestamp: string): string {
		const date = new Date(timestamp);
		const now = new Date();
		const isToday = date.toDateString() === now.toDateString();
		const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

		if (isToday) {
			return timeStr;
		}
		// Show date + time for older messages
		return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${timeStr}`;
	}

	function getProviderIcon(provider: string) {
		switch (provider.toLowerCase()) {
			case 'claude':
				return '🟠';
			case 'gemini':
				return '🔵';
			case 'codex':
				return '🟣';
			case 'chatgpt':
				return '🟢';
			default:
				return '🤖';
		}
	}

	// Claude Code history functions
	async function loadClaudeSessions() {
		claudeLoading = true;
		try {
			const result = await api.listClaudeHistory({ limit: 50 });
			claudeSessions = result.sessions;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load Claude Code history';
		} finally {
			claudeLoading = false;
		}
	}

	async function openClaudeSession(session: api.ClaudeCodeSession) {
		try {
			const detail = await api.getClaudeHistorySession(session.sessionId);
			selectedClaudeSession = detail;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load session';
		}
	}

	function closeClaudeSession() {
		selectedClaudeSession = null;
	}

	let copiedId = $state<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	async function copyResumeCommand(sessionId: string) {
		if (!sessionId) return;
		const cmd = `claude --resume ${sessionId}`;
		try {
			await navigator.clipboard.writeText(cmd);
			if (copyTimer) clearTimeout(copyTimer);
			copiedId = sessionId;
			copyTimer = setTimeout(() => { copiedId = null; copyTimer = null; }, 2000);
		} catch {
			error = 'Failed to copy to clipboard';
		}
	}

	let bridgingThread = $state<string | null>(null);
	let bridgedId = $state<string | null>(null);
	let bridgeTimer: ReturnType<typeof setTimeout> | null = null;

	async function bridgeAndCopy(threadId: string) {
		if (!threadId || bridgingThread) return;
		bridgingThread = threadId;
		try {
			const result = await api.bridgeThread(threadId);
			try {
				await navigator.clipboard.writeText(result.command);
			} catch {
				// Clipboard failed — show command in error banner as fallback
				error = `Bridge OK. Run: ${result.command}`;
			}
			if (bridgeTimer) clearTimeout(bridgeTimer);
			bridgedId = threadId;
			bridgeTimer = setTimeout(() => { bridgedId = null; bridgeTimer = null; }, 3000);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to bridge thread';
		} finally {
			bridgingThread = null;
		}
	}

	// Load Claude sessions when tab changes
	$effect(() => {
		if (activeTab === 'claude-code' && claudeSessions.length === 0 && !claudeLoading) {
			loadClaudeSessions();
		}
	});
</script>

<svelte:head>
	<title>Sessions | Microsoft Azure</title>
</svelte:head>

{#if auth.loading}
	<div class="loading-screen">
		<div class="loading-content">
			<div class="loading-spinner"></div>
			<p>Loading...</p>
		</div>
	</div>
{:else if !auth.isAuthorized}
	<AuthOverlay />
{:else}
<div class="sessions-page">
	<!-- Header -->
	<header class="page-header">
		<div class="header-content">
			<div class="header-left">
				<a href="/" class="back-btn" aria-label="Back to chat">
					<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
						<path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
					</svg>
				</a>
				<a href="/" class="azure-logo-link">
					<svg class="azure-icon" viewBox="0 0 23 23" fill="none">
						<rect width="11" height="11" fill="#f25022" />
						<rect x="12" width="11" height="11" fill="#7fba00" />
						<rect y="12" width="11" height="11" fill="#00a4ef" />
						<rect x="12" y="12" width="11" height="11" fill="#ffb900" />
					</svg>
				</a>
				<h1>Sessions</h1>
				<span class="count">{sessions.length}</span>
			</div>
			<button class="create-btn" onclick={() => (showNewSessionModal = true)}>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					width="18"
					height="18"
				>
					<path d="M12 5v14M5 12h14" />
				</svg>
				New Session
			</button>
		</div>
	</header>

	<!-- Tab Toggle -->
	<div class="tab-toggle">
		<button class="main-tab" class:active={activeTab === 'homer'} onclick={() => activeTab = 'homer'}>
			Azure Sessions
		</button>
		<button class="main-tab" class:active={activeTab === 'claude-code'} onclick={() => activeTab = 'claude-code'}>
			Claude Code
		</button>
	</div>

	<!-- Filters (Homer only) -->
	{#if activeTab === 'homer'}
	<div class="filters">
		<div class="search-box">
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				width="16"
				height="16"
			>
				<circle cx="11" cy="11" r="8" />
				<path d="M21 21l-4.35-4.35" />
			</svg>
			<input type="text" placeholder="Search sessions..." bind:value={searchQuery} />
		</div>
		<div class="status-tabs">
			<button class="tab" class:active={filterStatus === 'all'} onclick={() => (filterStatus = 'all')}>
				All <span class="tab-count">{statusCounts().all}</span>
			</button>
			<button
				class="tab"
				class:active={filterStatus === 'active'}
				onclick={() => (filterStatus = 'active')}
			>
				Active <span class="tab-count">{statusCounts().active || 0}</span>
			</button>
			<button
				class="tab"
				class:active={filterStatus === 'archived'}
				onclick={() => (filterStatus = 'archived')}
			>
				Archived <span class="tab-count">{statusCounts().archived || 0}</span>
			</button>
		</div>
	</div>
	{/if}

	<!-- Error banner -->
	{#if error}
		<div class="error-banner">
			<span>{error}</span>
			<button onclick={() => (error = null)}>Dismiss</button>
		</div>
	{/if}

	<!-- Sessions List -->
	{#if activeTab === 'homer'}
	<div class="sessions-list">
		{#if loading}
			<div class="loading">Loading sessions...</div>
		{:else if filteredSessions().length === 0}
			<EmptyState
				icon="sessions"
				title="No sessions found"
				description={searchQuery ? 'Try a different search term' : 'Create a new session to get started'}
			>
				{#if !searchQuery}
					<button class="empty-action-btn" onclick={() => (showNewSessionModal = true)}>
						Create Session
					</button>
				{/if}
			</EmptyState>
		{:else}
			{#each filteredSessions() as session}
				<button class="session-card" onclick={() => openSession(session)}>
					<div class="session-header">
						<h3 class="session-title">{session.name}</h3>
						{#if session.archivedAt}
							<StatusBadge status="archived" />
						{/if}
					</div>
					<div class="session-footer">
						<span class="session-time">{formatRelativeTime(session.updatedAt)}</span>
						<span class="session-count">{session.threadCount || 0} threads</span>
					</div>
				</button>
			{/each}
		{/if}
	</div>
	{:else}
	<!-- Claude Code Sessions List -->
	<div class="sessions-list">
		{#if claudeLoading}
			<div class="loading">Loading Claude Code history...</div>
		{:else if claudeSessions.length === 0}
			<EmptyState
				icon="sessions"
				title="No Claude Code sessions"
				description="Your Claude Code CLI history will appear here"
			/>
		{:else}
			{#each claudeSessions as session}
				<div class="session-card claude-session">
					<button class="session-card-main" onclick={() => openClaudeSession(session)}>
						<div class="session-header">
							<h3 class="session-title">{session.projectName}</h3>
							<span class="prompt-count">{session.promptCount} prompts</span>
						</div>
						<p class="session-preview">{session.firstPrompt}</p>
						<div class="session-footer">
							<span class="session-time">{formatRelativeTime(session.formattedEnd)}</span>
							<span class="session-project" title={session.project}>{session.project}</span>
						</div>
					</button>
					<div class="session-actions">
						<button
							class="copy-resume-btn"
							class:copied={copiedId === session.sessionId}
							onclick={() => copyResumeCommand(session.sessionId)}
							title="Copy: claude --resume {session.sessionId}"
							aria-label="Copy resume command for {session.projectName} session"
						>
							{#if copiedId === session.sessionId}
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14">
									<polyline points="20 6 9 17 4 12"/>
								</svg>
								Copied!
							{:else}
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
									<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
									<path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
								</svg>
								Resume
							{/if}
						</button>
					</div>
				</div>
			{/each}
		{/if}
	</div>
	{/if}
</div>

<!-- Claude Code Session Detail Modal -->
{#if selectedClaudeSession}
	<div class="modal-overlay" onclick={closeClaudeSession}>
		<div class="modal modal-large" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<div class="modal-title-row">
					<div>
						<h2>{selectedClaudeSession.projectName}</h2>
						<p class="modal-subtitle">{selectedClaudeSession.promptCount} prompts - {selectedClaudeSession.project}</p>
					</div>
				</div>
				<button class="modal-close" onclick={closeClaudeSession}>
					<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
						<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
					</svg>
				</button>
			</div>
			<div class="modal-body">
				<div class="claude-prompts-list">
					{#each selectedClaudeSession.prompts as prompt, i}
						<div class="claude-prompt">
							<div class="prompt-number">#{i + 1}</div>
							<div class="prompt-content">
								<p class="prompt-text">{prompt.display}</p>
								<span class="prompt-time">{new Date(prompt.timestamp).toLocaleString()}</span>
							</div>
						</div>
					{/each}
				</div>
			</div>
			<div class="modal-footer claude-modal-footer">
				<button
					class="resume-command"
					class:copied={copiedId === selectedClaudeSession.sessionId}
					onclick={() => copyResumeCommand(selectedClaudeSession!.sessionId)}
					title="Copy: claude --resume {selectedClaudeSession.sessionId}"
					aria-label="Copy resume command to clipboard"
				>
					{#if copiedId === selectedClaudeSession.sessionId}
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14">
							<polyline points="20 6 9 17 4 12"/>
						</svg>
						<span>Copied!</span>
					{:else}
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
							<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
							<path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
						</svg>
						<code>claude --resume {selectedClaudeSession.sessionId.slice(0, 8)}...</code>
					{/if}
				</button>
				<button class="secondary-btn" onclick={closeClaudeSession}>Close</button>
			</div>
		</div>
	</div>
{/if}

<!-- New Session Modal -->
{#if showNewSessionModal}
	<div class="modal-overlay" onclick={() => (showNewSessionModal = false)}>
		<div class="modal" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<h2>New Session</h2>
				<button class="modal-close" onclick={() => (showNewSessionModal = false)}>
					<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
						<path
							d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
						/>
					</svg>
				</button>
			</div>
			<div class="modal-body">
				<label>
					<span>Session Name</span>
					<input
						type="text"
						bind:value={newSessionName}
						placeholder="e.g., Project Planning"
						autofocus
					/>
				</label>
			</div>
			<div class="modal-footer">
				<button class="secondary-btn" onclick={() => (showNewSessionModal = false)}>Cancel</button>
				<button class="primary-btn" onclick={createSession} disabled={creatingSession || !newSessionName.trim()}>
					{creatingSession ? 'Creating...' : 'Create Session'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Session Detail Modal -->
{#if selectedSession}
	<div class="modal-overlay" onclick={closeSession}>
		<div class="modal modal-large" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<div class="modal-title-row">
					<div>
						<h2>{selectedSession.name}</h2>
						<p class="modal-subtitle">{selectedSession.threads.length} threads</p>
					</div>
				</div>
				<button class="modal-close" onclick={closeSession}>
					<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
						<path
							d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
						/>
					</svg>
				</button>
			</div>

			<div class="modal-body">
				{#if selectedThread}
					<!-- Thread View -->
					<div class="thread-view">
						<div class="thread-header">
							<button class="back-btn" onclick={closeThread}>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
									<path d="M19 12H5M12 19l-7-7 7-7" />
								</svg>
								Back to threads
							</button>
							<div class="thread-info">
								<span class="provider-icon">{getProviderIcon(selectedThread.provider)}</span>
								<span class="thread-title">{selectedThread.title || 'Untitled thread'}</span>
								<StatusBadge status={selectedThread.status} />
								<button
									class="bridge-cli-btn"
									onclick={() => bridgeAndCopy(selectedThread!.id)}
									disabled={bridgingThread === selectedThread.id}
									title="Bridge to Claude Code CLI"
								>
									{#if bridgingThread === selectedThread.id}
										...
									{:else if bridgedId === selectedThread.id}
										Copied!
									{:else}
										CLI
									{/if}
								</button>
							</div>
						</div>

						<div class="messages-container">
							{#each selectedThread.messages as message}
								<div class="message {message.role}">
									<div class="message-avatar">
										{#if message.role === 'user'}
											<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
												<path
													d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
												/>
											</svg>
										{:else}
											<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
												<path d="M12 2L9.5 9.5L2 12L9.5 14.5L12 22L14.5 14.5L22 12L14.5 9.5L12 2Z" />
											</svg>
										{/if}
									</div>
									<div class="message-content">
										<div class="message-header">
											<span class="message-role"
												>{message.role === 'user' ? 'You' : selectedThread.provider}</span
											>
											<span class="message-time">{formatMessageTime(message.createdAt)}</span>
										</div>
										<p class="message-text">{message.content}</p>
									</div>
								</div>
							{/each}

							{#if streamingContent}
								<div class="message assistant streaming">
									<div class="message-avatar">
										<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
											<path d="M12 2L9.5 9.5L2 12L9.5 14.5L12 22L14.5 14.5L22 12L14.5 9.5L12 2Z" />
										</svg>
									</div>
									<div class="message-content">
										{#if streamingSteps.length > 0}
											<div class="activity-panel">
												<div class="activity-panel-header">
													<span class="activity-panel-title">Run activity</span>
													<span class="activity-panel-count">{streamingSteps.length} step{streamingSteps.length === 1 ? '' : 's'}</span>
												</div>
												<div class="activity-list">
													{#each streamingSteps as step (step.id ?? `${step.type}:${step.label}:${step.startedAt}`)}
														<div class="activity-item" class:completed={step.completed} class:thinking={step.type === 'thinking'}>
															<div class="activity-icon">
																{#if activityIcon(step) === 'spark'}
																	<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
																		<path d="M12 2L9.5 9.5L2 12L9.5 14.5L12 22L14.5 14.5L22 12L14.5 9.5L12 2Z" />
																	</svg>
																{:else if activityIcon(step) === 'done'}
																	<svg class="activity-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
																		<path d="M20 6L9 17l-5-5" />
																	</svg>
																{:else}
																	<span class="activity-spinner"></span>
																{/if}
															</div>
															<div class="activity-body">
																<div class="activity-label">{activityLabel(step)}</div>
																{#if step.preview}
																	<div class="activity-preview">{step.preview}</div>
																{/if}
															</div>
														</div>
													{/each}
												</div>
											</div>
										{/if}
										{#if streamingContent}
											<p class="message-text">{streamingContent}<span class="cursor">|</span></p>
										{:else if streamingSteps.length > 0}
											<div class="activity-waiting">Preparing final response...</div>
										{/if}
									</div>
								</div>
							{:else if streamingSteps.length > 0}
								<div class="message assistant streaming">
									<div class="message-avatar">
										<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
											<path d="M12 2L9.5 9.5L2 12L9.5 14.5L12 22L14.5 14.5L22 12L14.5 9.5L12 2Z" />
										</svg>
									</div>
									<div class="message-content">
										<div class="activity-panel">
											<div class="activity-panel-header">
												<span class="activity-panel-title">Run activity</span>
												<span class="activity-panel-count">{streamingSteps.length} step{streamingSteps.length === 1 ? '' : 's'}</span>
											</div>
											<div class="activity-list">
												{#each streamingSteps as step (step.id ?? `${step.type}:${step.label}:${step.startedAt}`)}
													<div class="activity-item" class:completed={step.completed} class:thinking={step.type === 'thinking'}>
														<div class="activity-icon">
															{#if activityIcon(step) === 'spark'}
																<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
																	<path d="M12 2L9.5 9.5L2 12L9.5 14.5L12 22L14.5 14.5L22 12L14.5 9.5L12 2Z" />
																</svg>
															{:else if activityIcon(step) === 'done'}
																<svg class="activity-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
																	<path d="M20 6L9 17l-5-5" />
																</svg>
															{:else}
																<span class="activity-spinner"></span>
															{/if}
														</div>
														<div class="activity-body">
															<div class="activity-label">{activityLabel(step)}</div>
															{#if step.preview}
																<div class="activity-preview">{step.preview}</div>
															{/if}
														</div>
													</div>
												{/each}
											</div>
										</div>
										<div class="activity-waiting">Preparing final response...</div>
									</div>
								</div>
							{/if}
						</div>

						{#if selectedThread.status === 'active'}
							<div class="chat-composer-container">
								<div class="chat-composer">
									<!-- Attachment chips -->
									{#if attachedFiles.length > 0}
										<div class="attachment-area" role="list" aria-label="Attached files">
											{#each attachedFiles as file}
												<div class="attachment-chip" role="listitem">
													<span class="chip-name">{file.name}</span>
													<button
														class="chip-remove"
														onclick={() => removeFile(file)}
														aria-label="Remove {file.name}"
													>&times;</button>
												</div>
											{/each}
											<button class="chip-clear-all" onclick={clearAllFiles} aria-label="Clear all files">
												Clear all
											</button>
										</div>
										<div class="attachment-local-hint">
											Files upload to the Mac Mini local folder when you send this message, then Homer passes their local paths to the CLI. Max {MAX_FILE_SIZE_MB}MB per file.
										</div>
									{/if}

									<!-- Upload error -->
									{#if uploadError}
										<div class="upload-error">{uploadError}</div>
									{/if}

									<div class="textarea-wrapper">
										<!-- Attach button -->
										<button
											class="attach-btn"
											onclick={openFilePicker}
											disabled={sendingMessage || uploadingFiles}
											aria-label="Attach file"
										>
											<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
												<path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
											</svg>
										</button>

										<!-- Textarea -->
										<textarea
											bind:this={textareaRef}
											bind:value={messageInput}
											oninput={handleTextareaInput}
											onkeydown={handleKeydown}
											placeholder="Message Azure..."
											rows="1"
											disabled={sendingMessage || uploadingFiles}
											aria-label="Message Azure"
										></textarea>

										<!-- Send button -->
										<button
											class="send-btn"
											onclick={sendMessage}
											disabled={!canSend}
											aria-label="Send message"
										>
											{#if sendingMessage || uploadingFiles}
												<span class="spinner"></span>
											{:else}
												<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
													<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
												</svg>
											{/if}
										</button>
									</div>
								</div>
							</div>
						{:else if selectedThread.status === 'expired'}
							<div class="expired-notice">
								<p>This thread's session has expired.</p>
								<button class="primary-btn" onclick={() => createThread(selectedThread?.provider ?? 'claude')}>
									Start New Thread
								</button>
							</div>
						{/if}
					</div>
				{:else}
					<!-- Threads List -->
					<div class="threads-section">
						<div class="threads-header">
							<h3>Threads</h3>
							<button class="create-thread-btn" onclick={() => createThread('claude')}>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
									<path d="M12 5v14M5 12h14" />
								</svg>
								New Thread
							</button>
						</div>

						{#if selectedSession.threads.length === 0}
							<div class="empty-threads">
								<p>No threads yet. Create one to start chatting.</p>
							</div>
						{:else}
							<div class="threads-list">
								{#each selectedSession.threads as thread}
									<button class="thread-card" onclick={() => openThread(thread)}>
										<div class="thread-card-header">
											<span class="provider-icon">{getProviderIcon(thread.provider)}</span>
											<span class="thread-title">{thread.title || 'Untitled'}</span>
											<StatusBadge status={thread.status} />
										</div>
										<div class="thread-card-footer">
											<span>{formatRelativeTime(thread.lastMessageAt || thread.createdAt)}</span>
											<span>{thread.messageCount || 0} messages</span>
										</div>
									</button>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}
{/if}

<style>
	/* Loading screen */
	.loading-screen {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		background: #f2f2f2;
	}

	.loading-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		color: #666;
	}

	.loading-spinner {
		width: 32px;
		height: 32px;
		border: 3px solid #e6e6e6;
		border-top-color: #0078d4;
		border-radius: 50%;
		animation: spin 1s linear infinite;
	}

	.sessions-page {
		min-height: 100vh;
		background: #f2f2f2;
		font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
	}

	/* Header */
	.page-header {
		background: #1b1b1b;
		padding: 0 24px;
		height: 56px;
		display: flex;
		align-items: center;
	}

	.header-content {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 0;
	}

	.back-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		background: rgba(255, 255, 255, 0.1);
		border-radius: 6px;
		color: white;
		transition: all 0.2s ease;
		cursor: pointer;
		border: 1px solid rgba(255, 255, 255, 0.15);
		margin-right: 8px;
	}

	.back-btn:hover {
		background: rgba(255, 255, 255, 0.25);
		border-color: rgba(255, 255, 255, 0.4);
		transform: translateX(-2px);
	}

	.azure-logo-link {
		display: flex;
		align-items: center;
		padding: 4px;
		border-radius: 4px;
		transition: all 0.2s ease;
		margin-right: 12px;
	}

	.azure-logo-link:hover {
		background: rgba(255, 255, 255, 0.15);
	}

	.azure-icon {
		width: 20px;
		height: 20px;
		flex-shrink: 0;
	}

	h1 {
		color: white;
		font-size: 16px;
		font-weight: 600;
		margin: 0;
	}

	.count {
		background: rgba(255, 255, 255, 0.25);
		color: white;
		font-size: 12px;
		padding: 2px 8px;
		border-radius: 10px;
		margin-left: 8px;
	}

	.create-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		background: #0078d4;
		color: white;
		border: none;
		padding: 8px 16px;
		border-radius: 4px;
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.15s;
	}

	.create-btn:hover {
		background: #006cbe;
	}

	/* Tab Toggle */
	.tab-toggle {
		display: flex;
		background: white;
		border-bottom: 1px solid #e0e0e0;
		padding: 0 24px;
	}

	.main-tab {
		padding: 12px 20px;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		font-size: 14px;
		font-weight: 500;
		color: #666;
		cursor: pointer;
		transition: all 0.15s;
	}

	.main-tab:hover {
		color: #1b1b1b;
	}

	.main-tab.active {
		color: #0078d4;
		border-bottom-color: #0078d4;
	}

	/* Filters */
	.filters {
		background: white;
		padding: 16px 24px;
		border-bottom: 1px solid #e0e0e0;
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
		align-items: center;
	}

	.search-box {
		display: flex;
		align-items: center;
		gap: 8px;
		background: #f5f5f5;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		padding: 8px 12px;
		flex: 1;
		min-width: 200px;
		max-width: 300px;
	}

	.search-box svg {
		color: #666;
		flex-shrink: 0;
	}

	.search-box input {
		border: none;
		background: none;
		flex: 1;
		font-size: 14px;
		outline: none;
	}

	.status-tabs {
		display: flex;
		gap: 4px;
	}

	.tab {
		background: none;
		border: none;
		padding: 8px 12px;
		font-size: 13px;
		color: #666;
		cursor: pointer;
		border-radius: 4px;
		display: flex;
		align-items: center;
		gap: 6px;
		transition: all 0.15s;
	}

	.tab:hover {
		background: #f0f0f0;
	}

	.tab.active {
		background: #e5f1fb;
		color: #0078d4;
	}

	.tab-count {
		background: #e5e5e5;
		padding: 1px 6px;
		border-radius: 8px;
		font-size: 11px;
	}

	.tab.active .tab-count {
		background: #cce4f7;
	}

	/* Error banner */
	.error-banner {
		background: #fef2f2;
		border: 1px solid #fecaca;
		color: #b91c1c;
		padding: 12px 24px;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.error-banner button {
		background: none;
		border: none;
		color: #b91c1c;
		cursor: pointer;
		text-decoration: underline;
	}

	/* Loading */
	.loading {
		text-align: center;
		padding: 48px;
		color: #666;
	}

	/* Sessions List */
	.sessions-list {
		max-width: 1200px;
		margin: 0 auto;
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.session-card {
		background: white;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		padding: 16px;
		text-align: left;
		cursor: pointer;
		transition: all 0.15s;
		width: 100%;
	}

	.session-card:hover {
		border-color: #0078d4;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
	}

	.session-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 8px;
	}

	.session-title {
		flex: 1;
		font-size: 15px;
		font-weight: 600;
		color: #1b1b1b;
		margin: 0;
	}

	.session-footer {
		display: flex;
		justify-content: space-between;
		font-size: 12px;
		color: #888;
	}

	/* Modal */
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 24px;
	}

	.modal {
		background: white;
		border-radius: 8px;
		width: 100%;
		max-width: 500px;
		max-height: 90vh;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.modal-large {
		max-width: 800px;
	}

	.modal-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		padding: 16px 20px;
		border-bottom: 1px solid #e0e0e0;
	}

	.modal-title-row {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}

	.modal-header h2 {
		font-size: 18px;
		font-weight: 600;
		margin: 0;
		color: #1b1b1b;
	}

	.modal-subtitle {
		font-size: 13px;
		color: #666;
		margin: 4px 0 0 0;
	}

	.modal-close {
		background: none;
		border: none;
		padding: 4px;
		cursor: pointer;
		color: #666;
		display: flex;
	}

	.modal-close:hover {
		color: #1b1b1b;
	}

	.modal-body {
		padding: 20px;
		overflow-y: auto;
		flex: 1;
	}

	.modal-body label {
		display: block;
	}

	.modal-body label span {
		display: block;
		font-size: 14px;
		font-weight: 500;
		margin-bottom: 8px;
		color: #333;
	}

	.modal-body input {
		width: 100%;
		padding: 10px 12px;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		font-size: 14px;
	}

	.modal-footer {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
		padding: 16px 20px;
		border-top: 1px solid #e0e0e0;
	}

	.secondary-btn {
		padding: 8px 16px;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		background: white;
		font-size: 14px;
		cursor: pointer;
		transition: all 0.15s;
	}

	.secondary-btn:hover {
		background: #f5f5f5;
	}

	.primary-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 16px;
		border: none;
		border-radius: 4px;
		background: #0078d4;
		color: white;
		font-size: 14px;
		cursor: pointer;
		transition: all 0.15s;
	}

	.primary-btn:hover {
		background: #006cbe;
	}

	.primary-btn:disabled {
		background: #ccc;
		cursor: not-allowed;
	}

	.empty-action-btn {
		display: inline-block;
		padding: 8px 16px;
		background: #0078d4;
		color: white;
		border: none;
		border-radius: 4px;
		font-size: 14px;
		cursor: pointer;
	}

	/* Threads section */
	.threads-section h3 {
		font-size: 14px;
		font-weight: 600;
		margin: 0;
	}

	.threads-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 16px;
	}

	.create-thread-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		background: none;
		border: 1px solid #0078d4;
		color: #0078d4;
		padding: 6px 12px;
		border-radius: 4px;
		font-size: 13px;
		cursor: pointer;
	}

	.create-thread-btn:hover {
		background: #e5f1fb;
	}

	.threads-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.thread-card {
		background: #f5f5f5;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		padding: 12px;
		text-align: left;
		cursor: pointer;
		width: 100%;
		transition: all 0.15s;
	}

	.thread-card:hover {
		border-color: #0078d4;
	}

	.thread-card-header {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.provider-icon {
		font-size: 14px;
	}

	.thread-title {
		flex: 1;
		font-size: 14px;
		font-weight: 500;
	}

	.thread-card-footer {
		display: flex;
		justify-content: space-between;
		font-size: 12px;
		color: #888;
		margin-top: 8px;
	}

	.empty-threads {
		text-align: center;
		padding: 24px;
		color: #666;
	}

	/* Thread view */
	.thread-view {
		display: flex;
		flex-direction: column;
		height: 60vh;
	}

	.thread-header {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-bottom: 12px;
		border-bottom: 1px solid #e0e0e0;
		margin-bottom: 12px;
	}

	.back-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		background: none;
		border: none;
		color: #0078d4;
		cursor: pointer;
		font-size: 13px;
		padding: 0;
	}

	.back-btn:hover {
		text-decoration: underline;
	}

	.thread-info {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.bridge-cli-btn {
		padding: 2px 8px;
		font-size: 11px;
		font-weight: 600;
		border: 1px solid var(--border-color, #555);
		border-radius: 4px;
		background: transparent;
		color: var(--text-secondary, #aaa);
		cursor: pointer;
		white-space: nowrap;
		transition: all 0.15s ease;
	}

	.bridge-cli-btn:hover:not(:disabled) {
		background: var(--accent-color, #4a9eff);
		color: white;
		border-color: var(--accent-color, #4a9eff);
	}

	.bridge-cli-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.messages-container {
		flex: 1;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding: 12px 0;
	}

	.message {
		display: flex;
		gap: 12px;
	}

	.message-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.message.user .message-avatar {
		background: #e5e7eb;
		color: #4b5563;
	}

	.message.assistant .message-avatar {
		background: linear-gradient(135deg, #6264a7 0%, #464775 100%);
		color: white;
	}

	.message-content {
		flex: 1;
		min-width: 0;
	}

	.message-header {
		margin-bottom: 4px;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.message-role {
		font-size: 13px;
		font-weight: 600;
		color: #1b1b1b;
	}

	.message-time {
		font-size: 11px;
		color: #888;
		font-weight: 400;
	}

	.message-text {
		font-size: 14px;
		color: #444;
		line-height: 1.5;
		margin: 0;
		white-space: pre-wrap;
	}

	.streaming .message-text {
		color: #666;
	}

	.activity-panel {
		border: 1px solid #d1d5db;
		border-radius: 10px;
		background: #fff;
		box-shadow: 0 6px 18px rgba(15, 23, 42, 0.06);
		margin-bottom: 12px;
		overflow: hidden;
	}

	.activity-panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 12px;
		background: #f8fafc;
		border-bottom: 1px solid #e5e7eb;
	}

	.activity-panel-title {
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: #475569;
	}

	.activity-panel-count {
		font-size: 12px;
		color: #64748b;
	}

	.activity-list {
		display: flex;
		flex-direction: column;
	}

	.activity-item {
		display: flex;
		gap: 10px;
		padding: 12px;
		border-top: 1px solid #f1f5f9;
	}

	.activity-item:first-child {
		border-top: none;
	}

	.activity-item.thinking {
		background: #fcfcfd;
	}

	.activity-item.completed .activity-label {
		color: #0f172a;
	}

	.activity-icon {
		width: 20px;
		height: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		color: #2563eb;
	}

	.activity-spinner {
		width: 14px;
		height: 14px;
		border: 2px solid #cbd5e1;
		border-top-color: #2563eb;
		border-radius: 50%;
		animation: spin 1s linear infinite;
	}

	.activity-check {
		color: #16a34a;
	}

	.activity-body {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.activity-label {
		font-size: 14px;
		font-weight: 600;
		color: #334155;
		line-height: 1.4;
	}

	.activity-preview {
		font-size: 12px;
		color: #64748b;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.activity-waiting {
		font-size: 13px;
		color: #64748b;
		padding: 4px 2px 0;
	}

	.cursor {
		animation: blink 1s infinite;
	}

	@keyframes blink {
		0%,
		50% {
			opacity: 1;
		}
		51%,
		100% {
			opacity: 0;
		}
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* Microsoft Azure-style chat composer */
	.chat-composer-container {
		padding: 12px 16px;
		padding-bottom: calc(12px + env(safe-area-inset-bottom));
		background: #f2f2f2;
		border-top: 1px solid #e0e0e0;
		margin-top: auto;
	}

	.chat-composer {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 8px 12px;
		background: white;
		border-radius: 4px;
		border: 1px solid #e0e0e0;
		transition: border-color 0.2s, box-shadow 0.2s;
	}

	.chat-composer:focus-within {
		border-color: #0078d4;
		box-shadow: 0 0 0 1px #0078d4;
	}

	.attachment-area {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding-bottom: 4px;
	}

	.attachment-chip {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		background: #f0f0f0;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		font-size: 13px;
		color: #323130;
	}

	.chip-name {
		max-width: 150px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chip-remove {
		background: none;
		border: none;
		color: #605e5c;
		cursor: pointer;
		padding: 2px 4px;
		font-size: 14px;
		line-height: 1;
	}

	.chip-remove:hover {
		color: #323130;
	}

	.chip-clear-all {
		background: none;
		border: none;
		color: #605e5c;
		cursor: pointer;
		font-size: 12px;
		padding: 4px 8px;
	}

	.chip-clear-all:hover {
		color: #323130;
		text-decoration: underline;
	}

	.upload-error {
		color: #a4262c;
		font-size: 12px;
		padding: 4px 0;
	}

	.attachment-local-hint {
		font-size: 11px;
		color: #605e5c;
		padding-bottom: 4px;
	}

	.textarea-wrapper {
		display: flex;
		align-items: flex-end;
		gap: 8px;
	}

	.chat-composer textarea {
		flex: 1;
		border: none;
		background: transparent;
		resize: none;
		font-size: 14px;
		line-height: 1.5;
		max-height: 200px;
		overflow-y: auto;
		color: #323130;
		padding: 6px 0;
		font-family: inherit;
	}

	.chat-composer textarea::placeholder {
		color: #a19f9d;
	}

	.chat-composer textarea:focus {
		outline: none;
	}

	.chat-composer textarea:disabled {
		opacity: 0.6;
		background: #f5f5f5;
	}

	.attach-btn,
	.send-btn {
		width: 32px;
		height: 32px;
		min-width: 32px;
		border-radius: 4px;
		border: none;
		background: transparent;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #605e5c;
		transition: all 0.15s;
	}

	.attach-btn:hover:not(:disabled) {
		background: #f0f0f0;
		color: #323130;
	}

	.attach-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.send-btn:disabled {
		background: #f0f0f0;
		color: #a19f9d;
		cursor: not-allowed;
	}

	.send-btn:not(:disabled) {
		background: #0078d4;
		color: white;
	}

	.send-btn:not(:disabled):hover {
		background: #006cbe;
	}

	.spinner {
		width: 16px;
		height: 16px;
		border: 2px solid currentColor;
		border-top-color: transparent;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* Mobile adjustments */
	@media (max-width: 640px) {
		.chat-composer-container {
			padding: 8px 12px;
			padding-bottom: calc(8px + env(safe-area-inset-bottom));
		}

		.chat-composer {
			border-radius: 12px;
		}
	}

	.expired-notice {
		text-align: center;
		padding: 16px;
		background: #fef9c3;
		border-radius: 4px;
		margin-top: auto;
	}

	.expired-notice p {
		margin: 0 0 12px 0;
		color: #854d0e;
	}

	/* Claude Code specific styles */
	.claude-session {
		display: flex;
		align-items: stretch;
		padding: 0;
	}

	.claude-session .session-card-main {
		flex: 1;
		background: none;
		border: none;
		text-align: left;
		cursor: pointer;
		padding: 16px;
		min-width: 0;
	}

	.claude-session .session-actions {
		display: flex;
		align-items: center;
		padding: 0 12px;
		border-left: 1px solid #f0f0f0;
	}

	.copy-resume-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 6px 10px;
		background: none;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		font-size: 12px;
		color: #666;
		cursor: pointer;
		white-space: nowrap;
		transition: all 0.15s;
	}

	.copy-resume-btn:hover {
		background: #f0f0f0;
		border-color: #0078d4;
		color: #0078d4;
	}

	.copy-resume-btn.copied {
		background: #ecfdf5;
		border-color: #10b981;
		color: #065f46;
	}

	.claude-session .session-preview {
		font-size: 13px;
		color: #666;
		margin: 8px 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.prompt-count {
		font-size: 12px;
		color: #888;
		background: #f0f0f0;
		padding: 2px 8px;
		border-radius: 10px;
	}

	.session-project {
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.claude-prompts-list {
		display: flex;
		flex-direction: column;
		gap: 12px;
		max-height: 60vh;
		overflow-y: auto;
	}

	.claude-prompt {
		display: flex;
		gap: 12px;
		padding: 12px;
		background: #f9f9f9;
		border-radius: 4px;
	}

	.prompt-number {
		font-size: 12px;
		color: #888;
		background: #e0e0e0;
		padding: 4px 8px;
		border-radius: 4px;
		height: fit-content;
	}

	.prompt-content {
		flex: 1;
	}

	.prompt-text {
		font-size: 14px;
		line-height: 1.5;
		margin: 0 0 8px 0;
		color: #1b1b1b;
	}

	.prompt-time {
		font-size: 11px;
		color: #888;
	}

	.modal-info {
		font-size: 12px;
		color: #666;
		font-style: italic;
	}

	.claude-modal-footer {
		justify-content: space-between;
		align-items: center;
	}

	.resume-command {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		background: #1b1b1b;
		border: 1px solid #333;
		border-radius: 4px;
		cursor: pointer;
		transition: all 0.15s;
	}

	.resume-command:hover {
		background: #333;
		border-color: #555;
	}

	.resume-command.copied {
		background: #065f46;
		border-color: #10b981;
	}

	.resume-command code {
		font-size: 13px;
		color: #e0e0e0;
		font-family: 'SF Mono', 'Fira Code', monospace;
	}

	.resume-command span {
		font-size: 13px;
		color: #6ee7b7;
		font-weight: 500;
	}

	.resume-command svg {
		color: #e0e0e0;
	}

	.resume-command.copied svg {
		color: #6ee7b7;
	}

	/* Mobile Responsiveness */
	@media (max-width: 768px) {
		.filters {
			flex-direction: column;
			align-items: stretch;
		}

		.search-box {
			max-width: none;
		}

		.modal {
			max-width: 100%;
			margin: 16px;
			border-radius: 8px;
		}

		.modal-large {
			max-width: 100%;
		}
	}

	@media (max-width: 480px) {
		.page-header {
			padding: 0 12px;
		}

		.sessions-list {
			padding: 16px 12px;
		}

		.status-tabs {
			flex-wrap: wrap;
		}

		.thread-view {
			height: 50vh;
		}
	}
</style>
