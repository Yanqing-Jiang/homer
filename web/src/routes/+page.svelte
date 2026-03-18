<script lang="ts">
	import { user, signOut } from '$lib/supabase';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import * as api from '$lib/api/client';
	import { renderMarkdown, clearMarkdownCache, formatTime } from '$lib/utils/markdown';
	import { useAuth } from '$lib/hooks/useAuth.svelte';
	import { AuthOverlay } from '$lib/components';
	import ExecutorBadge from '$lib/components/ExecutorBadge.svelte';
	import ChatMessages from '$lib/components/ChatMessages.svelte';
	import ChatInput from '$lib/components/ChatInput.svelte';
	import SessionDropdown from '$lib/components/SessionDropdown.svelte';
	import SearchDropdown from '$lib/components/SearchDropdown.svelte';
	import { clickOutside } from '$lib/actions/clickOutside';

	const auth = useAuth();

	let searchQuery = $state('');
	let searchResults = $state<api.SessionSearchResult[]>([]);
	let showSearchDropdown = $state(false);
	let searchLoading = $state(false);
	let selectedSearchIndex = $state(-1);
	let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	let searchVersion = 0;

	let chatInput = $state('');
	let messages = $state<Array<{ id?: string; role: 'user' | 'assistant'; content: string; timestamp: Date }>>([]);
	let knownMessageIds = $state<Set<string>>(new Set());
	let sidebarOpen = $state(false);
	let userMenuOpen = $state(false);

	// Chat session state
	let sessionId = $state<string | null>(null);
	let threadId = $state<string | null>(null);
	let isStreaming = $state(false);
	let streamingContent = $state('');
	let streamingSteps = $state<Array<api.StepEvent & { startedAt: number; completed: boolean }>>([]);
	let currentAbort = $state<{ abort: () => void } | null>(null);
	let chatError = $state<string | null>(null);
	let sessionExpired = $state(false);
	let activeStreamGen = 0; // generation counter to guard stale callbacks

	function resetStreamingState() {
		isStreaming = false;
		streamingContent = '';
		streamingSteps = [];
		currentAbort = null;
	}

	// Session dropdown state
	let sessions = $state<api.ChatSession[]>([]);
	let showSessionDropdown = $state(false);
	let currentSessionName = $state('New Session');

	// Notification state — track when user last viewed each session
	const SEEN_KEY = 'homer_session_last_seen';
	let sessionLastSeen = $state<Record<string, string>>(loadSessionLastSeen());

	function loadSessionLastSeen(): Record<string, string> {
		try {
			return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
		} catch { return {}; }
	}

	function markSessionSeen(sid: string) {
		sessionLastSeen[sid] = new Date().toISOString();
		localStorage.setItem(SEEN_KEY, JSON.stringify(sessionLastSeen));
	}

	function hasUnread(sess: api.ChatSession): boolean {
		if (sess.id === sessionId) return false; // Active session is always "seen"
		const seen = sessionLastSeen[sess.id];
		if (!seen) return true; // Never opened = unread
		return new Date(sess.updatedAt) > new Date(seen);
	}

	// File upload state
	let attachedFiles = $state<api.Upload[]>([]);
	let chatInputComponent = $state<ChatInput | null>(null);
	let creatingAttachmentSession = $state<Promise<string | null> | null>(null);

	// Deploy action state
	let isDeploying = $state(false);

	async function handlePush() {
		if (isDeploying) return;
		isDeploying = true;
		messages = [...messages, { role: 'user', content: '/push', timestamp: new Date() }];
		try {
			const result = await api.pushChanges();
			const msg = result.success
				? result.message || 'Pushed successfully.'
				: `Push failed: ${result.error}`;
			messages = [...messages, { role: 'assistant', content: msg, timestamp: new Date() }];
		} catch (e) {
			messages = [...messages, { role: 'assistant', content: `Push failed: ${e instanceof Error ? e.message : 'Unknown error'}`, timestamp: new Date() }];
		}
		isDeploying = false;
	}

	async function handleDeploy() {
		if (isDeploying) return;
		isDeploying = true;
		messages = [...messages, { role: 'user', content: '/push-web', timestamp: new Date() }];
		messages = [...messages, { role: 'assistant', content: 'Building & deploying... This may take a minute.', timestamp: new Date() }];
		try {
			const result = await api.pushWeb();
			const msg = result.success
				? (result.message || 'Deployed successfully.') + (result.restarting ? '\n\nDaemon restarting — page will reconnect automatically.' : '')
				: `Deploy failed: ${result.error}`;
			messages = [...messages, { role: 'assistant', content: msg, timestamp: new Date() }];
		} catch (e) {
			const err = e instanceof Error ? e.message : 'Unknown error';
			// Connection drop during daemon restart is expected
			if (err.includes('fetch') || err.includes('network') || err.includes('Failed to fetch')) {
				messages = [...messages, { role: 'assistant', content: 'Deploy sent. Daemon restarting — page will reconnect automatically.', timestamp: new Date() }];
			} else {
				messages = [...messages, { role: 'assistant', content: `Deploy failed: ${err}`, timestamp: new Date() }];
			}
		}
		isDeploying = false;
	}

	// Full-page drag-drop state
	let pageDragCounter = $state(0);

	function handlePageDragEnter(e: DragEvent) {
		if (e.dataTransfer?.types.includes('Files')) {
			e.preventDefault();
			pageDragCounter++;
		}
	}

	function handlePageDragLeave(e: DragEvent) {
		if (e.dataTransfer?.types.includes('Files')) {
			pageDragCounter--;
		}
	}

	function handlePageDragOver(e: DragEvent) {
		if (e.dataTransfer?.types.includes('Files')) {
			e.preventDefault();
		}
	}

	function handlePageDrop(e: DragEvent) {
		e.preventDefault();
		pageDragCounter = 0;
		if (e.dataTransfer?.files.length) {
			chatInputComponent?.addFiles(e.dataTransfer.files);
		}
	}

	// Slash command state
	let showSlashCommands = $state(false);
	let selectedCommandIndex = $state(0);
	let dynamicCommands = $state<api.CommandDefinition[]>([]);
	let executorCommands = $state<Array<{ name: string; executor: api.ExecutorType; description: string; model?: string }>>([]);

	// Fallback commands (used until dynamic ones load)
	const fallbackCommands: api.CommandDefinition[] = [
		{ name: '/claude', category: 'executor', description: 'Switch to Claude (default)', executor: 'claude' as api.ExecutorType },
		{ name: '/sonnet', category: 'executor', description: 'Switch Claude to Sonnet', executor: 'claude' as api.ExecutorType, model: 'sonnet' },
		{ name: '/opus', category: 'executor', description: 'Switch Claude to Opus', executor: 'claude' as api.ExecutorType, model: 'opus' },
		{ name: '/codex', category: 'executor', description: 'Switch to Codex CLI', executor: 'codex' as api.ExecutorType },
		{ name: '/kimi', category: 'executor', description: 'Kimi K2.5 CLI (long-context)', executor: 'kimi' as api.ExecutorType },
		{ name: '/open_flash', category: 'executor', description: 'OpenCode + Gemini Flash', executor: 'opencode' as api.ExecutorType, model: 'google/gemini-3-flash-preview' },
		{ name: '/open_opus', category: 'executor', description: 'OpenCode + Claude Opus', executor: 'opencode' as api.ExecutorType, model: 'github-copilot/claude-opus-4.6' },
		{ name: '/chatgpt', category: 'executor', description: 'Use ChatGPT via browser skill', executor: 'chatgpt' as api.ExecutorType },
		{ name: '/new', category: 'session', description: 'Start fresh session (reset executor)' },
		{ name: '/search', category: 'search', description: 'Search memory files' },
	];

	// Local-only commands (always available, not from API)
	const localCommands: api.CommandDefinition[] = [
		{ name: '/log-memory', category: 'memory', description: 'Log session summary to daily memory' },
		{ name: '/push', category: 'system', description: 'Commit & push homer changes' },
		{ name: '/push-web', category: 'system', description: 'Build + push + restart (full deploy)' },
	];

	// Use dynamic commands if loaded, otherwise fallback, and always include local commands
	let slashCommands = $derived<api.CommandDefinition[]>([
		...(dynamicCommands.length > 0 ? dynamicCommands : fallbackCommands),
		...localCommands
	]);

	// Executor state
	let currentExecutor = $state<api.ExecutorType>('claude');
	let currentModel = $state<string | undefined>(undefined);
	let executorMessageCount = $state(0);

	// Filter commands based on input
	let filteredCommands = $derived(
		chatInput.startsWith('/')
			? slashCommands.filter(cmd => cmd.name.toLowerCase().includes(chatInput.toLowerCase()))
			: []
	);

	// Load commands from API
	async function loadCommands() {
		try {
			const response = await api.getCommands();
			dynamicCommands = response.commands;
			executorCommands = response.executors;
		} catch (error) {
			console.warn('Failed to load commands, using fallback:', error);
		}
	}

	// Load executor state for current session
	async function loadExecutorState() {
		if (!sessionId) {
			currentExecutor = 'claude';
			currentModel = undefined;
			executorMessageCount = 0;
			return;
		}
		try {
			const state = await api.getExecutorState(sessionId);
			currentExecutor = state.executor;
			currentModel = state.model;
			executorMessageCount = state.messageCount ?? 0;
		} catch (error) {
			console.warn('Failed to load executor state:', error);
		}
	}

	// Switch executor
	async function switchExecutor(executor: api.ExecutorType, model?: string) {
		if (!sessionId) return;
		try {
			if (currentAbort) {
				currentAbort.abort();
			}
			resetStreamingState();
			const result = await api.setExecutor(sessionId, executor, model);
			currentExecutor = result.executor;
			currentModel = result.model;
			executorMessageCount = 0;
		} catch (error) {
			console.error('Failed to switch executor:', error);
		}
	}

	// Clear executor (reset to Claude)
	async function resetExecutor() {
		if (!sessionId) return;
		try {
			if (currentAbort) {
				currentAbort.abort();
			}
			resetStreamingState();
			const result = await api.clearExecutor(sessionId);
			currentExecutor = result.executor;
			currentModel = result.model;
			executorMessageCount = 0;
		} catch (error) {
			console.error('Failed to reset executor:', error);
		}
	}

	function handleInputChange(e: Event) {
		const value = (e.target as HTMLTextAreaElement).value;
		chatInput = value;
		showSlashCommands = value.startsWith('/') && !value.includes(' ');
		selectedCommandIndex = 0;
	}


	function selectCommand(cmd: api.CommandDefinition) {
		// For executor commands, switch immediately if no additional input needed
		if (cmd.category === 'executor' && cmd.executor) {
			switchExecutor(cmd.executor, cmd.model);
			chatInput = '';
			showSlashCommands = false;
			return;
		}

		// For /new, reset executor
		if (cmd.name === '/new') {
			resetExecutor();
			chatInput = '';
			showSlashCommands = false;
			// Also start a new session
			selectSession(null);
			return;
		}

		// For /log-memory, log session to daily memory
		if (cmd.name === '/log-memory') {
			showSlashCommands = false;
			chatInput = buildLogMemoryMessage('work');
			handleSendMessage();
			return;
		}

		// For other commands, fill the input
		chatInput = cmd.name + ' ';
		showSlashCommands = false;
	}


	// Sidebar navigation items
	const sidebarItems = [
		{ name: 'Sessions', icon: 'chat', href: '/sessions' },
		{ name: 'Ideas', icon: 'lightbulb', href: '/ideas' },
		{ name: 'Plans', icon: 'clipboard', href: '/plans' },
		{ name: 'Jobs', icon: 'clock', href: '/jobs' },
		{ name: 'Trading', icon: 'chart', href: '/trading' }
	];

	// Track if we've checked for context
	let contextChecked = $state(false);

	// Race condition guards for auto-loading
	let isAutoLoading = $state(false);
	let autoLoadAttempted = $state(false);

	// Cleanup on component destroy to prevent memory leaks
	// Note: pollInterval and threadSubscription are cleaned up by $effect return functions
	onDestroy(() => {
		if (currentAbort) {
			currentAbort.abort();
		}
		resetStreamingState();
	});

	// Stored context from sessionStorage (read once, use when auth completes)
	let pendingContext = $state<{ type: 'session'; data: string } | null>(null);
	let pendingMessage = $state<string | null>(null);

	// Check for context passed from Ideas or Sessions pages
	// Read values immediately but defer removal until auth confirms
	onMount(() => {
		// Check for session resume
		const resumeSession = sessionStorage.getItem('resume_session');
		if (resumeSession) {
			pendingContext = { type: 'session', data: resumeSession };
			// Also check for a pending message to auto-send
			const storedMessage = sessionStorage.getItem('pending_message');
			if (storedMessage) {
				pendingMessage = storedMessage;
			}
			contextChecked = true;
			return;
		}

		contextChecked = true;
	});

	// Apply pending context after auth confirms and clear sessionStorage
	$effect(() => {
		if (!auth.loading && auth.isAuthorized && pendingContext) {
			const ctx = pendingContext;
			const msgToSend = pendingMessage;
			pendingContext = null; // Clear to prevent re-processing
			pendingMessage = null;

			sessionStorage.removeItem('resume_session');
			sessionStorage.removeItem('pending_message');
			(async () => {
				try {
					const sessionData = JSON.parse(ctx.data);
					sessionId = sessionData.sessionId || null;
					threadId = sessionData.threadId || null;
					currentSessionName = sessionData.name || 'Resumed Session';
					// Load thread messages if we have a threadId
					if (threadId) {
						await loadThreadMessages(threadId);
					}
					// Load executor state for resumed session
					if (sessionId) {
						loadExecutorState();
						// Refresh sessions list to include the new one
						loadSessions();
					}
					// Auto-send pending message after session is restored
					if (msgToSend) {
						chatInput = msgToSend;
						setTimeout(() => handleSendMessage(), 50);
					}
				} catch (e) {
					console.error('Failed to restore session:', e);
				}
			})();
		}
	});

	// Auto-load most recent thread after auth passes (if no context was provided)
	// Guards prevent concurrent calls and duplicate attempts
	$effect(() => {
		if (!auth.loading && auth.isAuthorized && contextChecked && !threadId && !chatInput && !isAutoLoading && !autoLoadAttempted) {
			autoLoadAttempted = true;
			loadMostRecentThread();
		}
	});

	// Load sessions and commands when authorized
	$effect(() => {
		if (!auth.loading && auth.isAuthorized) {
			loadSessions();
			loadCommands();
		}
	});

	// Background polling for session list (red dot updates)
	$effect(() => {
		if (!auth.loading && auth.isAuthorized) {
			const interval = setInterval(() => {
				if (!document.hidden) loadSessions();
			}, 15000);
			return () => clearInterval(interval);
		}
	});

	// Thread live updates via SSE — subscribe when threadId changes
	// NOT $state — internal bookkeeping only, must not trigger $effect re-runs
	let threadSubscription: { abort: () => void } | null = null;

	$effect(() => {
		if (!threadId || !auth.isAuthorized) return;

		const sub = api.subscribeToThread(threadId, {
			onMessage: (message) => {
				// Deduplicate by message ID
				if (message.id && knownMessageIds.has(message.id)) return;
				if (message.id) knownMessageIds.add(message.id);
				// Skip while actively streaming to avoid clobbering optimistic updates
				if (isStreaming) return;
				messages = [...messages, {
					id: message.id,
					role: message.role as 'user' | 'assistant',
					content: message.content,
					timestamp: new Date(message.createdAt)
				}];
			}
		});
		threadSubscription = sub;
		return () => sub.abort();
	});

	async function loadSessions() {
		try {
			const { sessions: loadedSessions } = await api.listSessions({ limit: 10 });
			sessions = loadedSessions;
		} catch (e) {
			console.error('Failed to load sessions:', e);
		}
	}

	async function loadMostRecentThread() {
		if (isAutoLoading) return; // Prevent concurrent calls
		isAutoLoading = true;

		try {
			const { sessions: loadedSessions } = await api.listSessions({ limit: 1 });
			if (loadedSessions.length === 0) return;

			const session = await api.getSession(loadedSessions[0].id);
			sessionId = session.id;
			currentSessionName = session.name;
			markSessionSeen(session.id);

			if (session.threads.length === 0) return;

			threadId = session.threads[0].id;
			await loadThreadMessages(threadId);
			await loadExecutorState();
		} catch (e) {
			console.error('Failed to auto-load:', e);
			// Fail silently - user can manually select
		} finally {
			isAutoLoading = false;
		}
	}

	// ============================================
	// Search
	// ============================================

	$effect(() => {
		const q = searchQuery.trim();

		if (searchDebounceTimer) clearTimeout(searchDebounceTimer);

		if (q.length < 2) {
			searchResults = [];
			showSearchDropdown = false;
			searchLoading = false;
			return;
		}

		searchLoading = true;
		showSearchDropdown = true;
		const version = ++searchVersion;

		searchDebounceTimer = setTimeout(async () => {
			try {
				const response = await api.searchSessions(q, { limit: 10 });
				if (version === searchVersion) {
					searchResults = response.sessions;
					showSearchDropdown = true;
					selectedSearchIndex = -1;
				}
			} catch {
				if (version === searchVersion) {
					searchResults = [];
				}
			} finally {
				if (version === searchVersion) {
					searchLoading = false;
				}
			}
		}, 300);
	});

	function handleSearchKeydown(e: KeyboardEvent) {
		if (!showSearchDropdown) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedSearchIndex = Math.min(selectedSearchIndex + 1, searchResults.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedSearchIndex = Math.max(selectedSearchIndex - 1, -1);
		} else if (e.key === 'Enter' && selectedSearchIndex >= 0) {
			e.preventDefault();
			const result = searchResults[selectedSearchIndex];
			if (result) handleSearchSelect(result);
		} else if (e.key === 'Escape') {
			showSearchDropdown = false;
		}
	}

	function handleSearchSelect(result: api.SessionSearchResult) {
		showSearchDropdown = false;
		searchQuery = '';
		searchResults = [];
		selectSession({ id: result.id, name: result.name, updatedAt: result.updatedAt, createdAt: result.updatedAt, archivedAt: null });
	}

	async function selectSession(session: api.ChatSession | null) {
		showSessionDropdown = false;
		clearMarkdownCache();
		sessionExpired = false;

		if (currentAbort) {
			currentAbort.abort();
		}
		resetStreamingState();

		if (!session) {
			// New session - also reset executor
			sessionId = null;
			threadId = null;
			messages = [];
			currentSessionName = 'New Session';
			currentExecutor = 'claude';
			currentModel = undefined;
			executorMessageCount = 0;
			return;
		}

		try {
			const fullSession = await api.getSession(session.id);
			sessionId = fullSession.id;
			currentSessionName = fullSession.name;
			markSessionSeen(fullSession.id);

			// Clear messages immediately to prevent stale flash
			messages = [];
			knownMessageIds = new Set();

			if (fullSession.threads.length > 0) {
				threadId = fullSession.threads[0].id;
				await loadThreadMessages(threadId);
			} else {
				threadId = null;
				messages = [];
			}

			// Load executor state for this session
			await loadExecutorState();
		} catch (e) {
			console.error('Failed to select session:', e);
		}
	}

	async function handleRenameSession(id: string, name: string) {
		try {
			await api.updateSession(id, { name });
			sessions = sessions.map(s => s.id === id ? { ...s, name } : s);
			if (sessionId === id) {
				currentSessionName = name;
			}
		} catch (e) {
			console.error('Failed to rename session:', e);
		}
	}

	async function handleDeleteSession(id: string) {
		try {
			await api.deleteSession(id).catch(e => {
				if (!e.message?.includes('404')) throw e;
			});
			sessions = sessions.filter(s => s.id !== id);
			if (sessionId === id) {
				if (currentAbort) {
					currentAbort.abort();
				}
				resetStreamingState();
				sessionId = null;
				threadId = null;
				messages = [];
				currentSessionName = 'New Session';
				currentExecutor = 'claude';
				currentModel = undefined;
				executorMessageCount = 0;
			}
		} catch (e) {
			console.error('Failed to delete session:', e);
		}
	}

	async function loadThreadMessages(tId: string) {
		try {
			const thread = await api.getThread(tId);
			// Filter out system messages — they're context for the model, not for display
			const displayMessages = thread.messages.filter(m => m.role !== 'system');
			knownMessageIds = new Set(displayMessages.map(m => m.id));
			messages = displayMessages.map((m) => ({
				id: m.id,
				role: m.role as 'user' | 'assistant',
				content: m.content,
				timestamp: m.createdAt ? new Date(m.createdAt) : new Date()
			}));
		} catch (e) {
			console.error('Failed to load thread messages:', e);
		}
	}

	function compileSessionSummary(): string {
		if (messages.length === 0) {
			return 'No messages in this session.';
		}
		// Compile a concise summary of the session
		const summary: string[] = [];
		summary.push(`Session: ${currentSessionName}`);
		summary.push(`Messages: ${messages.length}`);
		summary.push('');
		// Include key user messages (truncated)
		const userMsgs = messages.filter(m => m.role === 'user');
		if (userMsgs.length > 0) {
			summary.push('Topics discussed:');
			userMsgs.slice(0, 5).forEach((m, i) => {
				const content = m.content.slice(0, 100) + (m.content.length > 100 ? '...' : '');
				summary.push(`- ${content}`);
			});
			if (userMsgs.length > 5) {
				summary.push(`- ... and ${userMsgs.length - 5} more messages`);
			}
		}
		return summary.join('\n');
	}

	function buildLogMemoryMessage(context: string = 'work'): string {
		const summary = compileSessionSummary();
		return `Please use the memory_append MCP tool to log the following session summary to daily memory with context "${context}":

---
${summary}
---

Just confirm when done. Keep your response brief.`;
	}

	async function continueInNewThread() {
		if (!sessionId) return;
		try {
			// Grab last 6 messages as context
			const recentMessages = messages.slice(-6);
			const contextSummary = recentMessages
				.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 500)}`)
				.join('\n\n');

			// Create new thread
			const thread = await api.createThread(sessionId, {
				provider: currentExecutor,
				parentThreadId: threadId ?? undefined
			});

			// Switch to new thread
			threadId = thread.id;
			messages = [];
			knownMessageIds = new Set();
			sessionExpired = false;

			// Auto-send context summary
			chatInput = `Continuing from expired session. Previous context:\n\n${contextSummary}`;
			setTimeout(() => handleSendMessage(), 100);
		} catch (e) {
			console.error('Failed to continue in new thread:', e);
			chatError = e instanceof Error ? e.message : 'Failed to create new thread';
		}
	}

	async function handleSignOut() {
		userMenuOpen = false;
		await signOut();
		goto('/login');
	}

	async function handleSendMessage() {
		const hasPendingUploads = chatInputComponent?.hasPendingUploads() ?? false;
		if ((!chatInput.trim() && attachedFiles.length === 0) || hasPendingUploads || isStreaming) return;

		const typedMessage = chatInput.trim();
		const currentAttachments = attachedFiles.map((f) => f.path).filter(Boolean);
		const userMessage = typedMessage || `Attached files: ${attachedFiles.map((f) => f.filename).join(', ')}`;
		const executionMessage = typedMessage || 'Please inspect the attached file(s).';

		// Parse typed slash commands (e.g., "/gemini hello")
		if (userMessage.startsWith('/')) {
			const spaceIdx = userMessage.indexOf(' ');
			const cmdPart = spaceIdx > 0 ? userMessage.slice(0, spaceIdx) : userMessage;
			const queryPart = spaceIdx > 0 ? userMessage.slice(spaceIdx + 1).trim() : '';

			// Find matching command
			const aliasMap: Record<string, string> = { '/g': '/gemini', '/x': '/codex' };
			const resolvedCmd = aliasMap[cmdPart.toLowerCase()] || cmdPart;
			const matchedCmd = slashCommands.find(c => c.name.toLowerCase() === resolvedCmd.toLowerCase());

			if (matchedCmd) {
				// Handle executor switch commands
				if (matchedCmd.category === 'executor' && matchedCmd.executor) {
					await switchExecutor(matchedCmd.executor, matchedCmd.model);

					// If there's a query after the command, send it
					if (queryPart) {
						chatInput = queryPart;
						await handleSendMessage();
					} else {
						chatInput = '';
					}
					return;
				}

				// Handle /new command
				if (matchedCmd.name === '/new') {
					await resetExecutor();
					selectSession(null);
					chatInput = queryPart || '';
					return;
				}

				// Handle /log-memory command - transform and resend
				if (matchedCmd.name === '/log-memory') {
					const context = queryPart || 'work';
					chatInput = buildLogMemoryMessage(context);
					await handleSendMessage();
					return;
				}

				// Handle /push command
				if (matchedCmd.name === '/push') {
					chatInput = '';
					await handlePush();
					return;
				}

				// Handle /push-web command
				if (matchedCmd.name === '/push-web') {
					chatInput = '';
					await handleDeploy();
					return;
				}
			}
		}

		// Store previous state for rollback on failure
		const previousMessages = [...messages];
		const previousChatInput = chatInput;
		const previousAttachedFiles = [...attachedFiles];

		// Optimistic update
		chatInput = '';
		chatError = null;
		messages = [...messages, { role: 'user', content: userMessage, timestamp: new Date() }];

		// Reset textarea height and clear attachments
		chatInputComponent?.resetHeight();
		attachedFiles = [];
		chatInputComponent?.clearFiles();

			try {
				// Create session if needed
				if (!sessionId) {
					const ensuredSessionId = await ensureSessionForAttachments();
					if (!ensuredSessionId) {
						throw new Error('Failed to create session for attachments');
					}
				}

				// Create thread if needed
				if (!threadId) {
					if (!sessionId) {
						throw new Error('Missing session id');
					}
					const thread = await api.createThread(sessionId, { provider: currentExecutor });
					threadId = thread.id;
				}

			isStreaming = true;
			streamingContent = '';
			streamingSteps = [];
			const gen = ++activeStreamGen; // guard stale callbacks
			const isStale = () => gen !== activeStreamGen;

			if (currentExecutor === 'claude' || currentExecutor === 'chatgpt') {
				// SSE streaming path with step indicators
				const stream = api.streamMessage(threadId, executionMessage, {
					onDelta: (data) => {
						if (isStale()) return;
						streamingContent += data.content;
					},
					onStep: (data) => {
						if (isStale()) return;
						if (data.type === 'tool_use') {
							streamingSteps = [...streamingSteps, { ...data, startedAt: Date.now(), completed: false }];
						} else if (data.type === 'tool_result' && data.id) {
							streamingSteps = streamingSteps.map(s =>
								s.id === data.id ? { ...s, completed: true } : s
							);
						} else if (data.type === 'thinking') {
							streamingSteps = [...streamingSteps, { ...data, startedAt: Date.now(), completed: true }];
						}
					},
					onComplete: (data) => {
						if (isStale()) return;
						const finalContent = streamingContent;
						const expiredPattern = /session expired|session not found/i;
						if (expiredPattern.test(finalContent)) {
							sessionExpired = true;
						}

						// Use messageId from SSE complete event if available
						const completeMsgId = (data as Record<string, unknown>).messageId as string | null;
						if (completeMsgId && threadId) {
							// Fetch the specific message by listing thread messages
							api.getThread(threadId).then(thread => {
								if (isStale()) return;
								const msg = thread.messages?.find(m => m.id === completeMsgId);
								if (msg?.role === 'assistant') {
									messages = [...messages, { id: msg.id, role: 'assistant', content: msg.content, timestamp: new Date(msg.createdAt) }];
								} else if (finalContent) {
									messages = [...messages, { role: 'assistant', content: finalContent, timestamp: new Date() }];
								}
								resetStreamingState();
								executorMessageCount++;
							}).catch(() => {
								if (isStale()) return;
								if (finalContent) {
									messages = [...messages, { role: 'assistant', content: finalContent, timestamp: new Date() }];
								}
								resetStreamingState();
								executorMessageCount++;
							});
						} else {
							// No messageId — use streamed content directly
							if (finalContent) {
								messages = [...messages, { role: 'assistant', content: finalContent, timestamp: new Date() }];
							}
							resetStreamingState();
							executorMessageCount++;
						}
					},
					onError: (data) => {
						if (isStale()) return;
						if (data.code === 'AUTH_EXPIRED') {
							sessionExpired = true;
						}
						chatError = data.message;
						resetStreamingState();
					},
				}, {
					attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
					sessionId: sessionId ?? undefined,
				});

				currentAbort = stream;
			} else {
				// Non-Claude: execute + poll (no SSE streaming)
				streamingContent = 'Thinking...';
				try {
					const result = await api.executeMessage(threadId, executionMessage, currentAttachments.length > 0 ? currentAttachments : undefined);
					const runId = result.runId;

					const pollInterval = setInterval(async () => {
						try {
							const run = await api.getRun(runId);
							if (run.run.status === 'completed' || run.run.status === 'failed' || run.run.status === 'cancelled') {
								clearInterval(pollInterval);
								const output = run.run.output || (run.run.error ?? '');
								const expiredPattern = /session expired|session not found/i;
								if (expiredPattern.test(output) || expiredPattern.test(run.run.error ?? '')) {
									sessionExpired = true;
								}
								if (output) {
									messages = [...messages, { role: 'assistant', content: output, timestamp: new Date() }];
								} else if (run.run.status === 'cancelled') {
									chatError = 'Run cancelled.';
								}
								streamingContent = '';
								isStreaming = false;
								currentAbort = null;
								executorMessageCount++;
							}
						} catch (e) {
							clearInterval(pollInterval);
							chatError = e instanceof Error ? e.message : 'Failed to check run status';
							streamingContent = '';
							isStreaming = false;
							currentAbort = null;
						}
					}, 2000);

					currentAbort = { abort: () => clearInterval(pollInterval) };
				} catch (execError) {
					console.error('Execute error:', execError);
					chatError = execError instanceof Error ? execError.message : 'Execution failed';
					streamingContent = '';
					isStreaming = false;
				}
			}
		} catch (e) {
			console.error('Failed to send message:', e);
			chatError = e instanceof Error ? e.message : 'Failed to send message. Check if the daemon is running.';

			// Rollback optimistic update on failure
			messages = previousMessages;
			chatInput = previousChatInput;
			attachedFiles = previousAttachedFiles;

			isStreaming = false;
		}
	}

	function toggleSidebar() {
		sidebarOpen = !sidebarOpen;
	}

	async function ensureSessionForAttachments(): Promise<string | null> {
		if (sessionId) {
			return sessionId;
		}

		if (!creatingAttachmentSession) {
			creatingAttachmentSession = (async () => {
				try {
					const session = await api.createSession('Web Chat');
					sessionId = session.id;
					currentSessionName = session.name;
					markSessionSeen(session.id);
					loadSessions();
					return session.id;
				} catch (error) {
					chatError = error instanceof Error ? error.message : 'Failed to create session for attachments';
					return null;
				} finally {
					creatingAttachmentSession = null;
				}
			})();
		}

		return creatingAttachmentSession;
	}

	function toggleUserMenu() {
		userMenuOpen = !userMenuOpen;
	}
</script>

<svelte:head>
	<title>Microsoft Azure</title>
</svelte:head>

{#if auth.loading}
	<div class="loading-screen">
		<div class="loading-content">
			<svg class="azure-logo" viewBox="0 0 23 23" fill="none">
				<rect width="11" height="11" fill="#f25022" />
				<rect x="12" width="11" height="11" fill="#7fba00" />
				<rect y="12" width="11" height="11" fill="#00a4ef" />
				<rect x="12" y="12" width="11" height="11" fill="#ffb900" />
			</svg>
			<div class="loading-spinner"></div>
		</div>
	</div>
{:else if !auth.isAuthorized}
	<AuthOverlay />
{:else}
	<div class="azure-portal">
		<!-- Top Bar (Dark) -->
		<header class="top-bar">
			<div class="top-bar-left">
				<button class="hamburger-btn" aria-label="Menu" onclick={toggleSidebar}>
					<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
						<path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
					</svg>
				</button>
				<div class="azure-brand">
					<svg class="azure-icon" viewBox="0 0 23 23" fill="none">
						<rect width="11" height="11" fill="#f25022" />
						<rect x="12" width="11" height="11" fill="#7fba00" />
						<rect y="12" width="11" height="11" fill="#00a4ef" />
						<rect x="12" y="12" width="11" height="11" fill="#ffb900" />
					</svg>
					<span class="azure-text">Microsoft Azure</span>
				</div>
			</div>

			<div class="search-container" use:clickOutside={() => showSearchDropdown = false}>
				<svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="11" cy="11" r="8"/>
					<path d="M21 21l-4.35-4.35"/>
				</svg>
				<input
					type="text"
					class="search-input"
					placeholder="Search sessions and messages..."
					bind:value={searchQuery}
					onkeydown={handleSearchKeydown}
					onfocus={() => { if (searchResults.length > 0) showSearchDropdown = true; }}
				/>
				{#if showSearchDropdown}
					<SearchDropdown
						results={searchResults}
						loading={searchLoading}
						query={searchQuery}
						bind:selectedIndex={selectedSearchIndex}
						onselect={handleSearchSelect}
						onclose={() => showSearchDropdown = false}
					/>
				{/if}
			</div>

			<div class="top-bar-right">
				<button class="icon-btn" title="Cloud Shell">
					<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
						<path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10zm-2-1h-6v-2h6v2zM7.5 17l-1.41-1.41L8.67 13l-2.58-2.59L7.5 9l4 4-4 4z"/>
					</svg>
				</button>
				<button class="icon-btn" title="Notifications">
					<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
						<path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>
					</svg>
				</button>
				<button class="icon-btn" title="Settings">
					<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
						<path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
					</svg>
				</button>
				<button class="icon-btn" title="Help">
					<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
						<path d="M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z"/>
					</svg>
				</button>
				<!-- User Menu -->
				<div class="user-menu-container">
					<button class="user-btn" onclick={toggleUserMenu} title="Account">
						{#if $user?.user_metadata?.avatar_url}
							<img src={$user.user_metadata.avatar_url} alt="Avatar" class="user-avatar" />
						{:else}
							<div class="user-avatar-placeholder">
								{$user?.email?.[0].toUpperCase() || 'U'}
							</div>
						{/if}
					</button>
					{#if userMenuOpen}
						<div class="user-dropdown">
							<div class="user-dropdown-header">
								<div class="user-dropdown-avatar">
									{#if $user?.user_metadata?.avatar_url}
										<img src={$user.user_metadata.avatar_url} alt="Avatar" />
									{:else}
										<div class="avatar-placeholder-large">
											{$user?.email?.[0].toUpperCase() || 'U'}
										</div>
									{/if}
								</div>
								<div class="user-dropdown-info">
									<span class="user-dropdown-name">{$user?.user_metadata?.full_name || 'User'}</span>
									<span class="user-dropdown-email">{$user?.email || 'test@example.com'}</span>
								</div>
							</div>
							<div class="user-dropdown-divider"></div>
							<button class="user-dropdown-item" onclick={handleSignOut}>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
									<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
									<polyline points="16,17 21,12 16,7"/>
									<line x1="21" y1="12" x2="9" y2="12"/>
								</svg>
								Sign out
							</button>
						</div>
					{/if}
				</div>
			</div>
		</header>

		<!-- Sidebar -->
		{#if sidebarOpen}
			<div class="sidebar-overlay" onclick={toggleSidebar}></div>
			<aside class="sidebar">
				<div class="sidebar-header">
					<span>Azure services</span>
					<button class="sidebar-close" onclick={toggleSidebar} aria-label="Close sidebar">
						<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
							<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
						</svg>
					</button>
				</div>
				<nav class="sidebar-nav">
					{#each sidebarItems as item}
						<a href={item.href} class="sidebar-item">
							{#if item.icon === 'chat'}
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
									<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
								</svg>
							{:else if item.icon === 'lightbulb'}
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
									<path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
								</svg>
							{:else if item.icon === 'clipboard'}
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
									<path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/>
								</svg>
							{:else if item.icon === 'clock'}
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
									<path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
								</svg>
							{:else if item.icon === 'chart'}
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
									<path d="M3 3v18h18M7 16l4-4 4 4 6-6"/>
								</svg>
							{/if}
							<span>{item.name}</span>
						</a>
					{/each}
				</nav>
			</aside>
		{/if}

		<!-- Main Content -->
		<main class="main-content">
			<!-- Copilot Chat Interface (Full Width) -->
			<section class="copilot-section">
				<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="copilot-chat"
				ondragenter={handlePageDragEnter}
				ondragleave={handlePageDragLeave}
				ondragover={handlePageDragOver}
				ondrop={handlePageDrop}
			>
					<!-- Copilot Header (Unified) -->
					<div class="copilot-header">
						<div class="copilot-title">
							<svg class="copilot-icon" viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
								<path d="M12 2L9.5 9.5L2 12L9.5 14.5L12 22L14.5 14.5L22 12L14.5 9.5L12 2Z"/>
							</svg>
							<span class="copilot-name">Microsoft Copilot in Azure</span>
						</div>
						<div class="copilot-center">
							<!-- Empty or future nav tabs -->
						</div>
						<div class="copilot-right">
							<SessionDropdown
								{sessions}
								currentSessionId={sessionId}
								{currentSessionName}
								bind:isOpen={showSessionDropdown}
								{hasUnread}
								onSelectSession={(sess) => selectSession(sess)}
								onNewSession={() => selectSession(null)}
								onRenameSession={handleRenameSession}
								onDeleteSession={handleDeleteSession}
								onLoadSessions={loadSessions}
							/>
						<div class="executor-indicator">
							<ExecutorBadge executor={currentExecutor} model={currentModel} />
						</div>
					</div>
				</div>

					<!-- Error Banner -->
					{#if chatError}
						<div class="chat-error">
							<span>{chatError}</span>
							<button onclick={() => chatError = null}>Dismiss</button>
						</div>
					{/if}

					<!-- Session Expired Banner -->
					{#if sessionExpired}
						<div class="session-expired-banner">
							<span>Session expired. Context will be carried over.</span>
							<button onclick={() => continueInNewThread()}>Continue in New Thread</button>
							<button class="dismiss-btn" onclick={() => sessionExpired = false}>Dismiss</button>
						</div>
					{/if}

					<!-- Chat Messages Area -->
					<ChatMessages {messages} {isStreaming} {streamingContent} steps={streamingSteps} />

					<!-- Chat Input Area -->
					<ChatInput
						bind:this={chatInputComponent}
						bind:value={chatInput}
						{isStreaming}
						{sessionId}
						{ensureSessionForAttachments}
						bind:attachedFiles
						bind:showSlashCommands
						{filteredCommands}
						bind:selectedCommandIndex
						onSend={handleSendMessage}
						onSelectCommand={selectCommand}
						onInputChange={handleInputChange}
					/>

					{#if pageDragCounter > 0}
						<div class="page-drop-overlay">
							<div class="page-drop-content">
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="32" height="32">
									<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
									<polyline points="17 8 12 3 7 8"/>
									<line x1="12" y1="3" x2="12" y2="15"/>
								</svg>
								<span>Drop files here to upload them onto the Mac Mini</span>
							</div>
						</div>
					{/if}
				</div>
			</section>
		</main>
	</div>
{/if}

<style>
	/* Loading Screen */
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
		gap: 24px;
	}

	.azure-logo {
		width: 80px;
		height: 80px;
	}

	.loading-spinner {
		width: 32px;
		height: 32px;
		border: 3px solid #e6e6e6;
		border-top-color: #0078d4;
		border-radius: 50%;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	/* Azure Portal Layout */
	.azure-portal {
		min-height: 100vh;
		background: #f2f2f2;
		font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
	}

	/* Top Bar (Azure Blue) */
	.top-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 40px;
		background: #0078d4;
		color: white;
		padding: 0 8px;
		position: relative;
		z-index: 100;
	}

	.top-bar-left {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.hamburger-btn {
		background: none;
		border: none;
		color: white;
		padding: 8px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.hamburger-btn:hover {
		background: rgba(255, 255, 255, 0.1);
	}

	.azure-brand {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.azure-icon {
		width: 18px;
		height: 18px;
	}

	.azure-text {
		font-size: 14px;
		font-weight: 600;
	}

	.search-container {
		flex: 1;
		max-width: 600px;
		margin: 0 16px;
		position: relative;
	}

	.search-icon {
		position: absolute;
		left: 12px;
		top: 50%;
		transform: translateY(-50%);
		width: 16px;
		height: 16px;
		color: #0078d4;
	}

	.search-input {
		width: 100%;
		padding: 6px 12px 6px 36px;
		border: none;
		border-radius: 4px;
		font-size: 13px;
		background: white;
		color: #1b1b1b;
	}

	.search-input::placeholder {
		color: #666;
	}

	.search-input:focus {
		outline: 2px solid rgba(255, 255, 255, 0.5);
		background: #fff;
		color: #1b1b1b;
	}

	.top-bar-right {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.icon-btn {
		background: none;
		border: none;
		color: white;
		padding: 8px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.icon-btn:hover {
		background: rgba(255, 255, 255, 0.1);
	}

	/* User Menu */
	.user-menu-container {
		position: relative;
	}

	.user-btn {
		background: none;
		border: none;
		padding: 4px;
		cursor: pointer;
	}

	.user-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
	}

	.user-avatar-placeholder {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: #0078d4;
		color: white;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		font-weight: 600;
	}

	.user-dropdown {
		position: absolute;
		top: 100%;
		right: 0;
		margin-top: 4px;
		background: white;
		border: 1px solid #e0e0e0;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
		min-width: 280px;
		z-index: 1000;
	}

	.user-dropdown-header {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 16px;
	}

	.user-dropdown-avatar img,
	.avatar-placeholder-large {
		width: 48px;
		height: 48px;
		border-radius: 50%;
	}

	.avatar-placeholder-large {
		background: #0078d4;
		color: white;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 18px;
		font-weight: 600;
	}

	.user-dropdown-info {
		display: flex;
		flex-direction: column;
	}

	.user-dropdown-name {
		font-weight: 600;
		color: #1b1b1b;
		font-size: 14px;
	}

	.user-dropdown-email {
		color: #616161;
		font-size: 12px;
	}

	.user-dropdown-divider {
		height: 1px;
		background: #e0e0e0;
	}

	.user-dropdown-item {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 12px 16px;
		background: none;
		border: none;
		font-size: 14px;
		color: #1b1b1b;
		cursor: pointer;
		text-align: left;
	}

	.user-dropdown-item:hover {
		background: #f5f5f5;
	}

	/* Executor Indicator (in Copilot Header) */
	.executor-indicator {
		display: flex;
		align-items: center;
		gap: 6px;
	}


	/* Sidebar - Azure Portal Style (Dark Theme) */
	.sidebar-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.5);
		z-index: 200;
	}

	.sidebar {
		position: fixed;
		top: 0;
		left: 0;
		width: 280px;
		height: 100vh;
		background: #252423;
		z-index: 300;
		display: flex;
		flex-direction: column;
		box-shadow: 4px 0 8px rgba(0, 0, 0, 0.2);
	}

	.sidebar-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-bottom: 1px solid #3b3a39;
		color: #f3f2f1;
		font-weight: 600;
		font-size: 14px;
	}

	.sidebar-close {
		background: none;
		border: none;
		color: #f3f2f1;
		padding: 4px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 2px;
	}

	.sidebar-close:hover {
		background: #3b3a39;
	}

	.sidebar-nav {
		flex: 1;
		padding: 8px 0;
		overflow-y: auto;
	}

	.sidebar-item {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 16px;
		color: #d2d0ce;
		text-decoration: none;
		font-size: 13px;
		transition: background 0.1s, color 0.1s;
		border-left: 3px solid transparent;
	}

	.sidebar-item:hover {
		background: #3b3a39;
		color: #f3f2f1;
		border-left-color: #0078d4;
	}

	.sidebar-item svg {
		opacity: 0.85;
	}

	.sidebar-item:hover svg {
		opacity: 1;
	}

	/* Main Content */
	.main-content {
		max-width: 100%;
		margin: 0;
		padding: 0;
		height: calc(100vh - 40px); /* viewport minus top header only */
		display: flex;
		flex-direction: column;
	}

	/* Copilot Section - Full Width */
	.copilot-section {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.copilot-chat {
		background: white;
		border: none;
		border-radius: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		position: relative;
	}

	.page-drop-overlay {
		position: absolute;
		inset: 0;
		background: rgba(0, 120, 212, 0.08);
		border: 2px dashed #0078d4;
		border-radius: 8px;
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 50;
		pointer-events: none;
	}

	.page-drop-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		color: #0078d4;
		font-size: 16px;
		font-weight: 500;
	}

	/* Chat Error Banner */
	.chat-error {
		background: #fef2f2;
		border-bottom: 1px solid #fecaca;
		color: #b91c1c;
		padding: 10px 16px;
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 13px;
	}

	.chat-error button {
		background: none;
		border: none;
		color: #b91c1c;
		cursor: pointer;
		text-decoration: underline;
		font-size: 12px;
	}

	/* Session Expired Banner */
	.session-expired-banner {
		background: #fffbeb;
		border-bottom: 1px solid #fde68a;
		color: #92400e;
		padding: 10px 16px;
		display: flex;
		align-items: center;
		gap: 12px;
		font-size: 13px;
	}

	.session-expired-banner button {
		background: #f59e0b;
		border: none;
		color: white;
		cursor: pointer;
		padding: 4px 12px;
		border-radius: 4px;
		font-size: 12px;
		font-weight: 600;
		white-space: nowrap;
	}

	.session-expired-banner button:hover {
		background: #d97706;
	}

	.session-expired-banner button.dismiss-btn {
		background: none;
		color: #92400e;
		text-decoration: underline;
		padding: 0;
		font-weight: 400;
	}

	/* Copilot Header (Purple - Azure Copilot style) */
	.copilot-header {
		background: linear-gradient(135deg, #7B4FBE 0%, #5B3FA0 100%);
		padding: 10px 16px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}

	.copilot-title {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-shrink: 0;
	}

	.copilot-icon {
		color: white;
		width: 20px;
		height: 20px;
	}

	.copilot-name {
		color: white;
		font-weight: 600;
		font-size: 14px;
	}

	.copilot-center {
		flex: 1;
		display: flex;
		justify-content: center;
	}

	.copilot-right {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-shrink: 0;
	}

	/* Chat Messages */



	/* Mobile Responsiveness */
	@media (max-width: 768px) {
		.search-container {
			display: none;
		}
	}

	@media (max-width: 480px) {
		.top-bar-right .icon-btn:not(:last-child) {
			display: none;
		}

		.azure-text {
			display: none;
		}
	}
</style>
