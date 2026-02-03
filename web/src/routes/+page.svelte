<script lang="ts">
	import { user, signOut } from '$lib/supabase';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import * as api from '$lib/api/client';
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import { useAuth } from '$lib/hooks/useAuth.svelte';
	import { AuthOverlay } from '$lib/components';
	import FileUpload from '$lib/components/FileUpload.svelte';

	const auth = useAuth();

	let searchQuery = $state('');
	let chatInput = $state('');
	let messages = $state<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
	let sidebarOpen = $state(false);
	let userMenuOpen = $state(false);

	// Chat session state
	let sessionId = $state<string | null>(null);
	let threadId = $state<string | null>(null);
	let isStreaming = $state(false);
	let streamingContent = $state('');
	let currentAbort = $state<{ abort: () => void } | null>(null);
	let chatError = $state<string | null>(null);

	// Session dropdown state
	let sessions = $state<api.ChatSession[]>([]);
	let showSessionDropdown = $state(false);
	let currentSessionName = $state('New Session');

	// File upload state
	let attachedFiles = $state<api.Upload[]>([]);
	let fileUploadComponent: FileUpload;

	// Slash command state
	let showSlashCommands = $state(false);
	let selectedCommandIndex = $state(0);
	const slashCommands = [
		{ name: '/chatgpt', description: 'Send message to ChatGPT via browser agent', example: '/chatgpt What is the weather?' },
		{ name: '/gemini', description: 'Send message to Gemini via browser agent', example: '/gemini Explain quantum computing' },
		{ name: '/claude', description: 'Send message to Claude web via browser agent', example: '/claude Write a poem' },
		{ name: '/search', description: 'Search memory files', example: '/search project ideas' },
		{ name: '/jobs', description: 'List scheduled jobs', example: '/jobs' },
		{ name: '/trigger', description: 'Trigger a scheduled job', example: '/trigger morning-brief' },
	];

	// Filter commands based on input
	let filteredCommands = $derived(
		chatInput.startsWith('/')
			? slashCommands.filter(cmd => cmd.name.toLowerCase().includes(chatInput.toLowerCase()))
			: []
	);

	function handleInputChange(e: Event) {
		const value = (e.target as HTMLInputElement).value;
		chatInput = value;
		showSlashCommands = value.startsWith('/') && !value.includes(' ');
		selectedCommandIndex = 0;
	}

	function selectCommand(cmd: typeof slashCommands[0]) {
		chatInput = cmd.name + ' ';
		showSlashCommands = false;
	}

	function handleCommandKeydown(e: KeyboardEvent) {
		if (!showSlashCommands || filteredCommands.length === 0) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedCommandIndex = Math.min(selectedCommandIndex + 1, filteredCommands.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedCommandIndex = Math.max(selectedCommandIndex - 1, 0);
		} else if (e.key === 'Tab' || (e.key === 'Enter' && showSlashCommands)) {
			e.preventDefault();
			selectCommand(filteredCommands[selectedCommandIndex]);
		} else if (e.key === 'Escape') {
			showSlashCommands = false;
		}
	}

	// Sidebar navigation items
	const sidebarItems = [
		{ name: 'Sessions', icon: 'chat', href: '/sessions' },
		{ name: 'Ideas', icon: 'lightbulb', href: '/ideas' },
		{ name: 'Plans', icon: 'clipboard', href: '/plans' },
		{ name: 'Jobs', icon: 'clock', href: '/jobs' }
	];

	// Configure marked for safe rendering
	marked.setOptions({
		breaks: true,
		gfm: true
	});

	// DOMPurify configuration with explicit allowlist for XSS protection
	const DOMPURIFY_CONFIG = {
		ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'b', 'i', 'a', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr', 'span', 'div'],
		ALLOWED_ATTR: ['href', 'src', 'alt', 'class', 'target', 'rel', 'title'],
		ALLOW_DATA_ATTR: false
	};

	// Hook to force safe link attributes on all anchors
	DOMPurify.addHook('afterSanitizeAttributes', (node) => {
		if (node.tagName === 'A') {
			node.setAttribute('target', '_blank');
			node.setAttribute('rel', 'noopener noreferrer');
		}
	});

	function renderMarkdown(content: string): string {
		const html = marked.parse(content) as string;
		return DOMPurify.sanitize(html, DOMPURIFY_CONFIG) as string;
	}

	// Track if we've checked for context
	let contextChecked = $state(false);

	// Race condition guards for auto-loading
	let isAutoLoading = $state(false);
	let autoLoadAttempted = $state(false);

	// Cleanup on component destroy to prevent memory leaks
	onDestroy(() => {
		if (currentAbort) {
			currentAbort.abort();
			currentAbort = null;
		}
	});

	// Stored context from sessionStorage (read once, use when auth completes)
	let pendingContext = $state<{ type: 'idea' | 'session'; data: string } | null>(null);

	// Check for context passed from Ideas or Sessions pages
	// Read values immediately but defer removal until auth confirms
	onMount(() => {
		// Check for idea context
		const ideaContext = sessionStorage.getItem('copilot_context');
		if (ideaContext) {
			pendingContext = { type: 'idea', data: ideaContext };
			contextChecked = true;
			return;
		}

		// Check for session resume
		const resumeSession = sessionStorage.getItem('resume_session');
		if (resumeSession) {
			pendingContext = { type: 'session', data: resumeSession };
			contextChecked = true;
			return;
		}

		contextChecked = true;
	});

	// Apply pending context after auth confirms and clear sessionStorage
	$effect(() => {
		if (!auth.loading && auth.isAuthorized && pendingContext) {
			const ctx = pendingContext;
			pendingContext = null; // Clear to prevent re-processing

			if (ctx.type === 'idea') {
				sessionStorage.removeItem('copilot_context');
				chatInput = ctx.data;
			} else if (ctx.type === 'session') {
				sessionStorage.removeItem('resume_session');
				try {
					const sessionData = JSON.parse(ctx.data);
					sessionId = sessionData.sessionId || null;
					threadId = sessionData.threadId || null;
					// Load thread messages if we have a threadId
					if (threadId) {
						loadThreadMessages(threadId);
					}
				} catch (e) {
					console.error('Failed to restore session:', e);
				}
			}
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

	// Load sessions for dropdown when authorized
	$effect(() => {
		if (!auth.loading && auth.isAuthorized) {
			loadSessions();
		}
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

			if (session.threads.length === 0) return;

			threadId = session.threads[0].id;
			await loadThreadMessages(threadId);
		} catch (e) {
			console.error('Failed to auto-load:', e);
			// Fail silently - user can manually select
		} finally {
			isAutoLoading = false;
		}
	}

	async function selectSession(session: api.ChatSession | null) {
		showSessionDropdown = false;

		if (!session) {
			// New session
			sessionId = null;
			threadId = null;
			messages = [];
			currentSessionName = 'New Session';
			return;
		}

		try {
			const fullSession = await api.getSession(session.id);
			sessionId = fullSession.id;
			currentSessionName = fullSession.name;

			if (fullSession.threads.length > 0) {
				threadId = fullSession.threads[0].id;
				await loadThreadMessages(threadId);
			} else {
				threadId = null;
				messages = [];
			}
		} catch (e) {
			console.error('Failed to select session:', e);
		}
	}

	async function loadThreadMessages(tId: string) {
		try {
			const thread = await api.getThread(tId);
			messages = thread.messages.map((m) => ({
				role: m.role as 'user' | 'assistant',
				content: m.content
			}));
		} catch (e) {
			console.error('Failed to load thread messages:', e);
		}
	}


	async function handleSignOut() {
		userMenuOpen = false;
		await signOut();
		goto('/login');
	}

	async function handleSendMessage() {
		if (!chatInput.trim() || isStreaming) return;

		const userMessage = chatInput.trim();
		const currentAttachments = attachedFiles.map(f => f.id);

		// Store previous state for rollback on failure
		const previousMessages = [...messages];
		const previousChatInput = chatInput;
		const previousAttachedFiles = [...attachedFiles];

		// Optimistic update
		chatInput = '';
		chatError = null;
		messages = [...messages, { role: 'user', content: userMessage }];

		// Clear attachments after sending
		attachedFiles = [];
		fileUploadComponent?.clearFiles();

		try {
			// Create session if needed
			if (!sessionId) {
				const session = await api.createSession('Web Chat');
				sessionId = session.id;
				currentSessionName = session.name;
				loadSessions(); // Refresh dropdown
			}

			// Create thread if needed
			if (!threadId) {
				const thread = await api.createThread(sessionId, { provider: 'claude' });
				threadId = thread.id;
			}

			// Start streaming
			isStreaming = true;
			streamingContent = '';

			currentAbort = api.streamMessage(threadId, userMessage, {
				onStart: () => {
					// Message started
				},
				onDelta: (data) => {
					streamingContent += data.content;
				},
				onComplete: () => {
					// Finalize the assistant message
					messages = [...messages, { role: 'assistant', content: streamingContent }];
					streamingContent = '';
					isStreaming = false;
					currentAbort = null;
				},
				onError: (data) => {
					console.error('Stream error:', data.message);
					chatError = data.message;
					if (streamingContent) {
						messages = [...messages, { role: 'assistant', content: streamingContent }];
					}
					streamingContent = '';
					isStreaming = false;
					currentAbort = null;
				}
			}, {
				attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
				sessionId: sessionId || undefined
			});
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

			<div class="search-container">
				<svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="11" cy="11" r="8"/>
					<path d="M21 21l-4.35-4.35"/>
				</svg>
				<input
					type="text"
					class="search-input"
					placeholder="Search resources, services, and docs (G+/)"
					bind:value={searchQuery}
				/>
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

		<!-- Blue Ribbon (Session Selector) -->
		<div class="directory-ribbon">
			<div class="session-selector">
				<button class="session-dropdown-btn" onclick={() => showSessionDropdown = !showSessionDropdown}>
					<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
						<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
					</svg>
					<span class="session-name">{currentSessionName}</span>
					<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12" class="chevron" class:open={showSessionDropdown}>
						<path d="M7 10l5 5 5-5z"/>
					</svg>
				</button>
				{#if showSessionDropdown}
					<div class="session-dropdown">
						<button class="session-dropdown-item new-session" onclick={() => selectSession(null)}>
							<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
								<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
							</svg>
							New Session
						</button>
						<div class="session-dropdown-divider"></div>
						{#if sessions.length === 0}
							<div class="session-dropdown-empty">No recent sessions</div>
						{:else}
							{#each sessions as sess}
								<button
									class="session-dropdown-item"
									class:active={sess.id === sessionId}
									onclick={() => selectSession(sess)}
								>
									<span class="session-item-name">{sess.name}</span>
									<span class="session-item-date">{new Date(sess.updatedAt).toLocaleDateString()}</span>
								</button>
							{/each}
						{/if}
						<div class="session-dropdown-divider"></div>
						<a href="/sessions" class="session-dropdown-item view-all">
							View All Sessions
							<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
								<path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
							</svg>
						</a>
					</div>
				{/if}
			</div>
		</div>
		{#if showSessionDropdown}
			<div class="session-dropdown-overlay" onclick={() => showSessionDropdown = false}></div>
		{/if}

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
				<div class="copilot-chat">
					<!-- Copilot Header -->
					<div class="copilot-header">
						<div class="copilot-title">
							<svg class="copilot-icon" viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
								<path d="M12 2L9.5 9.5L2 12L9.5 14.5L12 22L14.5 14.5L22 12L14.5 9.5L12 2Z"/>
							</svg>
							<div class="copilot-title-text">
								<span class="copilot-name">Microsoft Copilot in Azure</span>
								<span class="copilot-preview">Preview</span>
							</div>
						</div>
						<button class="copilot-close" aria-label="Close">
							<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
								<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
							</svg>
						</button>
					</div>

					<!-- Error Banner -->
					{#if chatError}
						<div class="chat-error">
							<span>{chatError}</span>
							<button onclick={() => chatError = null}>Dismiss</button>
						</div>
					{/if}

					<!-- Chat Messages Area -->
					<div class="chat-messages">
						{#if messages.length === 0 && !isStreaming}
							<!-- Welcome Message -->
							<div class="message assistant">
								<div class="message-avatar">
									<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
										<path d="M12 2L9.5 9.5L2 12L9.5 14.5L12 22L14.5 14.5L22 12L14.5 9.5L12 2Z"/>
									</svg>
								</div>
								<div class="message-content">
									<div class="message-bubble">
										Hi! I'm Homer AI. I can help you manage your sessions, ideas, plans, and jobs. What would you like to do?
									</div>
								</div>
							</div>
						{:else}
							{#each messages as message}
								<div class="message {message.role}">
									{#if message.role === 'assistant'}
										<div class="message-avatar">
											<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
												<path d="M12 2L9.5 9.5L2 12L9.5 14.5L12 22L14.5 14.5L22 12L14.5 9.5L12 2Z"/>
											</svg>
										</div>
									{/if}
									<div class="message-content">
										{#if message.role === 'assistant'}
											<div class="message-bubble markdown-content">{@html renderMarkdown(message.content)}</div>
										{:else}
											<div class="message-bubble">{message.content}</div>
										{/if}
									</div>
								</div>
							{/each}
							{#if isStreaming && streamingContent}
								<div class="message assistant streaming">
									<div class="message-avatar">
										<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
											<path d="M12 2L9.5 9.5L2 12L9.5 14.5L12 22L14.5 14.5L22 12L14.5 9.5L12 2Z"/>
										</svg>
									</div>
									<div class="message-content">
										<div class="message-bubble markdown-content">{@html renderMarkdown(streamingContent)}<span class="cursor">|</span></div>
									</div>
								</div>
							{:else if isStreaming}
								<div class="message assistant streaming">
									<div class="message-avatar">
										<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
											<path d="M12 2L9.5 9.5L2 12L9.5 14.5L12 22L14.5 14.5L22 12L14.5 9.5L12 2Z"/>
										</svg>
									</div>
									<div class="message-content">
										<div class="message-bubble"><span class="typing-indicator"><span></span><span></span><span></span></span></div>
									</div>
								</div>
							{/if}
						{/if}
					</div>

					<!-- Chat Input Area -->
					<div class="chat-input-area">
						<div class="input-row">
							<FileUpload
								bind:this={fileUploadComponent}
								sessionId={sessionId}
								onFilesChange={(files) => attachedFiles = files}
							/>
							<div class="input-container">
								{#if showSlashCommands && filteredCommands.length > 0}
									<div class="slash-command-dropdown">
										{#each filteredCommands as cmd, i}
											<button
												class="slash-command-item"
												class:selected={i === selectedCommandIndex}
												onclick={() => selectCommand(cmd)}
											>
												<span class="cmd-name">{cmd.name}</span>
												<span class="cmd-desc">{cmd.description}</span>
											</button>
										{/each}
									</div>
								{/if}
								<input
									type="text"
									placeholder="Ask me anything... (type / for commands)"
									class="chat-input"
									bind:value={chatInput}
									disabled={isStreaming}
									oninput={handleInputChange}
									onkeydown={(e) => {
										handleCommandKeydown(e);
										if (e.key === 'Enter' && !showSlashCommands) handleSendMessage();
									}}
								/>
								<button class="send-btn" onclick={handleSendMessage} disabled={!chatInput.trim() || isStreaming} aria-label="Send">
									{#if isStreaming}
										<span class="spinner-small"></span>
									{:else}
										<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
											<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
										</svg>
									{/if}
								</button>
							</div>
						</div>
						<div class="input-disclaimer">
							AI-generated content may be incorrect
						</div>
					</div>
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

	/* Top Bar (Dark) */
	.top-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 40px;
		background: #1b1b1b;
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
		color: #666;
	}

	.search-input {
		width: 100%;
		padding: 6px 12px 6px 36px;
		border: none;
		border-radius: 2px;
		font-size: 13px;
		background: #3b3b3b;
		color: white;
	}

	.search-input::placeholder {
		color: #999;
	}

	.search-input:focus {
		outline: 2px solid #0078d4;
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

	/* Blue Ribbon with Main Tabs and Session Selector */
	.directory-ribbon {
		background: #0078d4;
		padding: 6px 16px;
		display: flex;
		align-items: center;
		gap: 8px;
		position: relative;
		z-index: 50;
	}

	.session-selector {
		position: relative;
	}

	.session-dropdown-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		color: white;
		font-size: 13px;
		cursor: pointer;
		background: none;
		border: none;
		padding: 4px 8px;
		border-radius: 4px;
		transition: background 0.15s;
	}

	.session-dropdown-btn:hover {
		background: rgba(255, 255, 255, 0.15);
	}

	.session-name {
		font-weight: 500;
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chevron {
		opacity: 0.8;
		transition: transform 0.2s;
	}

	.chevron.open {
		transform: rotate(180deg);
	}

	.session-dropdown {
		position: absolute;
		top: 100%;
		left: 0;
		margin-top: 4px;
		background: white;
		border: 1px solid #e0e0e0;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
		min-width: 280px;
		z-index: 1000;
		border-radius: 4px;
		max-height: 400px;
		overflow-y: auto;
	}

	.session-dropdown-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		width: 100%;
		padding: 10px 16px;
		background: none;
		border: none;
		font-size: 13px;
		color: #1b1b1b;
		cursor: pointer;
		text-align: left;
		text-decoration: none;
	}

	.session-dropdown-item:hover {
		background: #f5f5f5;
	}

	.session-dropdown-item.active {
		background: #e8f4fc;
		color: #0078d4;
	}

	.session-dropdown-item.new-session {
		color: #0078d4;
		font-weight: 500;
	}

	.session-dropdown-item.view-all {
		color: #0078d4;
	}

	.session-item-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.session-item-date {
		font-size: 11px;
		color: #666;
		flex-shrink: 0;
	}

	.session-dropdown-divider {
		height: 1px;
		background: #e0e0e0;
		margin: 4px 0;
	}

	.session-dropdown-empty {
		padding: 12px 16px;
		color: #666;
		font-size: 13px;
		font-style: italic;
	}

	.session-dropdown-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 49;
	}

	/* Sidebar */
	.sidebar-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.4);
		z-index: 200;
	}

	.sidebar {
		position: fixed;
		top: 0;
		left: 0;
		width: 280px;
		height: 100vh;
		background: #1b1b1b;
		z-index: 300;
		display: flex;
		flex-direction: column;
	}

	.sidebar-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-bottom: 1px solid #333;
		color: white;
		font-weight: 600;
	}

	.sidebar-close {
		background: none;
		border: none;
		color: white;
		padding: 4px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.sidebar-close:hover {
		background: rgba(255, 255, 255, 0.1);
	}

	.sidebar-nav {
		flex: 1;
		padding: 8px 0;
	}

	.sidebar-item {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
		color: #ccc;
		text-decoration: none;
		font-size: 14px;
		transition: all 0.15s;
	}

	.sidebar-item:hover {
		background: rgba(255, 255, 255, 0.1);
		color: white;
	}

	/* Main Content */
	.main-content {
		max-width: 100%;
		margin: 0;
		padding: 0;
		height: calc(100vh - 78px); /* viewport minus header and ribbon */
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

	/* Copilot Header - Purple Gradient */
	.copilot-header {
		background: linear-gradient(135deg, #6264a7 0%, #464775 100%);
		padding: 12px 16px;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.copilot-title {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.copilot-icon {
		color: white;
	}

	.copilot-title-text {
		display: flex;
		flex-direction: column;
	}

	.copilot-name {
		color: white;
		font-weight: 600;
		font-size: 14px;
	}

	.copilot-preview {
		color: rgba(255, 255, 255, 0.7);
		font-size: 11px;
	}

	.copilot-close {
		background: none;
		border: none;
		color: white;
		padding: 4px;
		cursor: pointer;
		opacity: 0.8;
	}

	.copilot-close:hover {
		opacity: 1;
	}

	/* Chat Messages */
	.chat-messages {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 16px;
		background: #faf9f8;
	}

	/* Center messages in full-width layout */
	.chat-messages .message {
		max-width: 900px;
	}

	.chat-messages .message.assistant {
		margin-right: auto;
	}

	.chat-messages .message.user {
		margin-left: auto;
	}

	.message {
		display: flex;
		gap: 10px;
	}

	.message.user {
		flex-direction: row-reverse;
	}

	.message-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: linear-gradient(135deg, #6264a7 0%, #464775 100%);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		color: white;
	}

	.message-content {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.message-bubble {
		padding: 10px 14px;
		font-size: 14px;
		line-height: 1.5;
	}

	.message.assistant .message-bubble {
		background: white;
		border: 1px solid #e0e0e0;
		border-radius: 2px 8px 8px 8px;
		color: #1b1b1b;
	}

	.message.user .message-bubble {
		background: #e1dfdd;
		border-radius: 8px 2px 8px 8px;
		color: #1b1b1b;
	}

	/* Chat Input */
	.chat-input-area {
		padding: 12px 24px;
		border-top: 1px solid #e0e0e0;
		background: white;
	}

	.input-row {
		display: flex;
		align-items: flex-end;
		gap: 8px;
		max-width: 900px;
		margin: 0 auto;
	}

	.input-container {
		display: flex;
		align-items: center;
		gap: 8px;
		background: #f5f5f5;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		padding: 4px 8px 4px 12px;
		flex: 1;
		position: relative;
	}

	.input-container:focus-within {
		border-color: #6264a7;
		box-shadow: 0 0 0 1px #6264a7;
	}

	/* Slash Command Dropdown */
	.slash-command-dropdown {
		position: absolute;
		bottom: 100%;
		left: 0;
		right: 0;
		background: white;
		border: 1px solid #e0e0e0;
		border-radius: 8px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		margin-bottom: 4px;
		max-height: 240px;
		overflow-y: auto;
		z-index: 100;
	}

	.slash-command-item {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		width: 100%;
		padding: 10px 14px;
		border: none;
		background: transparent;
		cursor: pointer;
		text-align: left;
		transition: background 0.1s;
	}

	.slash-command-item:hover,
	.slash-command-item.selected {
		background: #f0f4ff;
	}

	.slash-command-item .cmd-name {
		font-weight: 600;
		font-size: 14px;
		color: #6264a7;
	}

	.slash-command-item .cmd-desc {
		font-size: 12px;
		color: #666;
	}

	.chat-input {
		flex: 1;
		border: none;
		background: transparent;
		font-size: 14px;
		padding: 8px 0;
		outline: none;
	}

	.chat-input::placeholder {
		color: #888;
	}

	.send-btn {
		width: 36px;
		height: 36px;
		border-radius: 4px;
		background: #6264a7;
		border: none;
		color: white;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s;
	}

	.send-btn:hover:not(:disabled) {
		background: #464775;
	}

	.send-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.input-disclaimer {
		font-size: 11px;
		color: #888;
		margin-top: 8px;
		text-align: center;
	}

	/* Streaming and typing indicators */
	.streaming .message-bubble {
		border-color: #6264a7;
	}

	.cursor {
		animation: blink 1s infinite;
		color: #6264a7;
	}

	@keyframes blink {
		0%, 50% { opacity: 1; }
		51%, 100% { opacity: 0; }
	}

	.typing-indicator {
		display: flex;
		gap: 4px;
		padding: 4px 0;
	}

	.typing-indicator span {
		width: 8px;
		height: 8px;
		background: #6264a7;
		border-radius: 50%;
		animation: bounce 1.4s infinite ease-in-out both;
	}

	.typing-indicator span:nth-child(1) { animation-delay: -0.32s; }
	.typing-indicator span:nth-child(2) { animation-delay: -0.16s; }
	.typing-indicator span:nth-child(3) { animation-delay: 0; }

	@keyframes bounce {
		0%, 80%, 100% { transform: scale(0); }
		40% { transform: scale(1); }
	}

	.spinner-small {
		width: 16px;
		height: 16px;
		border: 2px solid rgba(255, 255, 255, 0.3);
		border-top-color: white;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	/* Markdown content styling */
	.markdown-content {
		line-height: 1.6;
	}

	.markdown-content :global(p) {
		margin: 0 0 0.5em 0;
	}

	.markdown-content :global(p:last-child) {
		margin-bottom: 0;
	}

	.markdown-content :global(code) {
		background: rgba(0, 0, 0, 0.05);
		padding: 2px 6px;
		border-radius: 3px;
		font-family: monospace;
		font-size: 0.9em;
	}

	.markdown-content :global(pre) {
		background: #1e1e1e;
		color: #d4d4d4;
		padding: 12px;
		border-radius: 6px;
		overflow-x: auto;
		margin: 8px 0;
	}

	.markdown-content :global(pre code) {
		background: none;
		padding: 0;
		color: inherit;
	}

	.markdown-content :global(ul), .markdown-content :global(ol) {
		margin: 8px 0;
		padding-left: 20px;
	}

	.markdown-content :global(li) {
		margin: 4px 0;
	}

	.markdown-content :global(h1), .markdown-content :global(h2), .markdown-content :global(h3) {
		margin: 12px 0 8px 0;
		font-weight: 600;
	}

	.markdown-content :global(h1) { font-size: 1.4em; }
	.markdown-content :global(h2) { font-size: 1.2em; }
	.markdown-content :global(h3) { font-size: 1.1em; }

	.markdown-content :global(blockquote) {
		border-left: 3px solid #6264a7;
		padding-left: 12px;
		margin: 8px 0;
		color: #666;
	}

	.markdown-content :global(a) {
		color: #0078d4;
		text-decoration: none;
	}

	.markdown-content :global(a:hover) {
		text-decoration: underline;
	}

	/* Mobile Responsiveness */
	@media (max-width: 768px) {
		.search-container {
			display: none;
		}

		.chat-messages {
			padding: 16px;
		}

		.chat-messages .message {
			max-width: 100%;
		}
	}

	@media (max-width: 480px) {
		.top-bar-right .icon-btn:not(:last-child) {
			display: none;
		}

		.azure-text {
			display: none;
		}

		.session-name {
			max-width: 120px;
		}
	}
</style>
