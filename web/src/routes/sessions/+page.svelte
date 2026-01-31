<script lang="ts">
	import { onMount } from 'svelte';
	import { StatusBadge, EmptyState, AuthOverlay } from '$lib/components';
	import { useAuth } from '$lib/hooks/useAuth.svelte';
	import * as api from '$lib/api/client';

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
			const fullSession = await api.getSession(session.id);
			selectedSession = fullSession;
			selectedThread = null;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load session';
		}
	}

	async function openThread(thread: api.Thread) {
		try {
			const fullThread = await api.getThread(thread.id);
			selectedThread = fullThread;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load thread';
		}
	}

	async function createThread(provider: 'claude' | 'chatgpt' | 'gemini' = 'claude') {
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

	async function sendMessage() {
		if (!selectedThread || !messageInput.trim() || sendingMessage) return;

		const content = messageInput.trim();
		messageInput = '';
		sendingMessage = true;
		streamingContent = '';

		// Optimistically add user message
		const tempUserMessage: api.ThreadMessage = {
			id: 'temp-' + Date.now(),
			threadId: selectedThread.id,
			role: 'user',
			content,
			metadata: null,
			createdAt: new Date().toISOString()
		};

		selectedThread = {
			...selectedThread,
			messages: [...selectedThread.messages, tempUserMessage]
		};

		const stream = api.streamMessage(selectedThread.id, content, {
			onStart: (data) => {
				// Update temp message with real ID
				if (selectedThread) {
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
				if (selectedThread && streamingContent) {
					const assistantMessage: api.ThreadMessage = {
						id: data.messageId,
						threadId: selectedThread.id,
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
				error = data.message;
				if (data.code === 'SESSION_EXPIRED' && selectedThread) {
					selectedThread = { ...selectedThread, status: 'expired' };
				}
				streamingContent = '';
			}
		});
	}

	function closeSession() {
		selectedSession = null;
		selectedThread = null;
	}

	function closeThread() {
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

	function getProviderIcon(provider: string) {
		switch (provider.toLowerCase()) {
			case 'claude':
				return '🟠';
			case 'chatgpt':
				return '🟢';
			case 'gemini':
				return '🔵';
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

	// Load Claude sessions when tab changes
	$effect(() => {
		if (activeTab === 'claude-code' && claudeSessions.length === 0 && !claudeLoading) {
			loadClaudeSessions();
		}
	});
</script>

<svelte:head>
	<title>Sessions | Homer</title>
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
				<a href="/" class="back-link">
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						width="20"
						height="20"
					>
						<path d="M19 12H5M12 19l-7-7 7-7" />
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
			Homer Sessions
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
				<button class="session-card claude-session" onclick={() => openClaudeSession(session)}>
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
			<div class="modal-footer">
				<span class="modal-info">Read-only view - Claude responses not stored in history.jsonl</span>
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
										<p class="message-text">{streamingContent}<span class="cursor">|</span></p>
									</div>
								</div>
							{/if}
						</div>

						{#if selectedThread.status === 'active'}
							<div class="chat-input">
								<input
									type="text"
									bind:value={messageInput}
									placeholder="Type a message..."
									disabled={sendingMessage}
									onkeydown={(e) => e.key === 'Enter' && sendMessage()}
								/>
								<button class="send-btn" onclick={sendMessage} disabled={sendingMessage || !messageInput.trim()}>
									{#if sendingMessage}
										<span class="spinner"></span>
									{:else}
										<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
											<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
										</svg>
									{/if}
								</button>
							</div>
						{:else if selectedThread.status === 'expired'}
							<div class="expired-notice">
								<p>This thread's session has expired.</p>
								<button class="primary-btn" onclick={() => createThread(selectedThread?.provider)}>
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
		max-width: 1200px;
		margin: 0 auto;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.back-link {
		color: #ccc;
		display: flex;
		align-items: center;
		padding: 8px;
		margin: -8px;
		border-radius: 4px;
		transition: all 0.15s;
	}

	.back-link:hover {
		color: white;
		background: rgba(255, 255, 255, 0.1);
	}

	h1 {
		color: white;
		font-size: 18px;
		font-weight: 600;
		margin: 0;
	}

	.count {
		background: rgba(255, 255, 255, 0.2);
		color: white;
		font-size: 12px;
		padding: 2px 8px;
		border-radius: 10px;
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
	}

	.message-role {
		font-size: 13px;
		font-weight: 600;
		color: #1b1b1b;
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

	.chat-input {
		display: flex;
		gap: 8px;
		padding-top: 12px;
		border-top: 1px solid #e0e0e0;
		margin-top: auto;
	}

	.chat-input input {
		flex: 1;
		padding: 10px 12px;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		font-size: 14px;
	}

	.chat-input input:disabled {
		background: #f5f5f5;
	}

	.send-btn {
		width: 40px;
		height: 40px;
		border: none;
		border-radius: 4px;
		background: #0078d4;
		color: white;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.send-btn:hover {
		background: #006cbe;
	}

	.send-btn:disabled {
		background: #ccc;
		cursor: not-allowed;
	}

	.spinner {
		width: 16px;
		height: 16px;
		border: 2px solid white;
		border-top-color: transparent;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
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
