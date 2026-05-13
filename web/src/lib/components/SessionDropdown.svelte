<script lang="ts">
	import type { ChatSession } from '$lib/api/client';

	let {
		sessions,
		currentSessionId,
		currentSessionName,
		isOpen = $bindable(false),
		hasUnread,
		hasAnyUnread = false,
		onSelectSession,
		onNewSession,
		onRenameSession,
		onDeleteSession,
		onLoadSessions
	}: {
		sessions: ChatSession[];
		currentSessionId: string | null;
		currentSessionName: string;
		isOpen: boolean;
		hasUnread: (sess: ChatSession) => boolean;
		hasAnyUnread?: boolean;
		onSelectSession: (sess: ChatSession) => void;
		onNewSession: () => void;
		onRenameSession: (id: string, name: string) => Promise<void>;
		onDeleteSession: (id: string) => Promise<void>;
		onLoadSessions: () => void;
	} = $props();

	// Internal editing/deleting state
	let editingSessionId = $state<string | null>(null);
	let editingName = $state('');
	let deletingSessionId = $state<string | null>(null);
	let isDeleting = $state(false);

	function toggle() {
		isOpen = !isOpen;
		if (isOpen) onLoadSessions();
	}

	function startRenaming(sess: ChatSession, event: MouseEvent) {
		event.stopPropagation();
		deletingSessionId = null;
		editingSessionId = sess.id;
		editingName = sess.name;
	}

	async function saveRename(event?: KeyboardEvent) {
		if (event && event.key !== 'Enter') return;
		if (!editingSessionId || !editingName.trim()) {
			cancelRename();
			return;
		}
		await onRenameSession(editingSessionId, editingName.trim());
		editingSessionId = null;
		editingName = '';
	}

	function cancelRename() {
		editingSessionId = null;
		editingName = '';
	}

	function startDeleting(sess: ChatSession, event: MouseEvent) {
		event.stopPropagation();
		editingSessionId = null;
		editingName = '';
		deletingSessionId = sess.id;
	}

	async function confirmDelete() {
		if (!deletingSessionId || isDeleting) return;
		const idToDelete = deletingSessionId;
		isDeleting = true;
		try {
			await onDeleteSession(idToDelete);
		} finally {
			deletingSessionId = null;
			isDeleting = false;
		}
	}

	function cancelDelete() {
		deletingSessionId = null;
	}
</script>

{#if isOpen}
	<div class="session-dropdown-overlay" onclick={() => isOpen = false}></div>
{/if}

<div class="session-selector">
	<button
		class="session-dropdown-btn"
		onclick={toggle}
		aria-label="{currentSessionName}{hasAnyUnread ? ' (unread messages)' : ''}"
	>
		<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
			<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
		</svg>
		<span class="session-name">{currentSessionName}</span>
		<svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10" class="chevron" class:open={isOpen}>
			<path d="M7 10l5 5 5-5z"/>
		</svg>
		{#if hasAnyUnread}
			<span class="btn-unread-badge" aria-hidden="true"></span>
		{/if}
	</button>
	{#if isOpen}
		<div class="session-dropdown">
			<button class="session-dropdown-item new-session" onclick={() => { isOpen = false; onNewSession(); }}>
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
					{#if editingSessionId === sess.id}
						<div class="session-dropdown-item editing">
							<input
								type="text"
								class="session-rename-input"
								bind:value={editingName}
								onkeydown={(e) => e.key === 'Enter' ? saveRename() : e.key === 'Escape' ? cancelRename() : null}
								onblur={() => saveRename()}
								autofocus
							/>
							<button class="session-rename-save" onclick={() => saveRename()}>
								<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
									<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
								</svg>
							</button>
						</div>
					{:else if deletingSessionId === sess.id}
						<div class="session-dropdown-item deleting">
							<span class="session-delete-label">Delete this chat?</span>
							<div class="session-delete-actions">
								<button class="session-delete-confirm" onclick={() => confirmDelete()} disabled={isDeleting}>
									{isDeleting ? '...' : 'Delete'}
								</button>
								<button class="session-delete-cancel" onclick={() => cancelDelete()} disabled={isDeleting}>Cancel</button>
							</div>
						</div>
					{:else}
						<div
							class="session-dropdown-item"
							class:active={sess.id === currentSessionId}
						>
							<button class="session-item-main" onclick={() => { isOpen = false; onSelectSession(sess); }}>
								<span class="session-item-name">{sess.name}</span>
								<span class="session-item-meta">
									{#if hasUnread(sess)}<span class="unread-dot" aria-label="Unread activity"></span>{/if}
									{#if sess.activeRunId}<span class="running-indicator" aria-label="Processing"></span>{/if}
									<span class="session-item-date">{new Date(sess.activityAt ?? sess.updatedAt).toLocaleDateString()}</span>
								</span>
							</button>
							<button class="session-rename-btn" onclick={(e) => startRenaming(sess, e)} title="Rename" aria-label="Rename session {sess.name}">
								<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
									<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
								</svg>
							</button>
							<button class="session-delete-btn" onclick={(e) => startDeleting(sess, e)} title="Delete" aria-label="Delete session {sess.name}">
								<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
									<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
								</svg>
							</button>
						</div>
					{/if}
				{/each}
			{/if}
		</div>
	{/if}
</div>

<style>
	.session-selector {
		position: relative;
	}

	.session-dropdown-btn {
		position: relative;
		display: flex;
		align-items: center;
		gap: 6px;
		color: white;
		font-size: 12px;
		cursor: pointer;
		background: rgba(255, 255, 255, 0.15);
		border: none;
		padding: 4px 10px;
		border-radius: 4px;
		transition: background 0.15s;
	}

	.session-dropdown-btn:hover {
		background: rgba(255, 255, 255, 0.25);
	}

	.session-name {
		font-weight: 500;
		max-width: 150px;
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
		right: 0;
		margin-top: 8px;
		background: white;
		border: 1px solid #e0e0e0;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
		min-width: 280px;
		max-width: calc(100vw - 40px);
		z-index: 1000;
		border-radius: 4px;
		max-height: 400px;
		overflow-y: auto;
	}

	.session-dropdown-item {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 10px 16px;
		background: none;
		border: none;
		font-size: 13px;
		color: #1b1b1b;
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

	.session-item-main {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		background: none;
		border: none;
		padding: 0;
		font-size: 13px;
		color: #1b1b1b;
		cursor: pointer;
		text-align: left;
		min-width: 0;
	}

	.session-item-meta {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	.unread-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #dc2626;
		display: inline-block;
		flex-shrink: 0;
	}

	.running-indicator {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #f59e0b;
		display: inline-block;
		flex-shrink: 0;
		animation: pulse 1.5s ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	.btn-unread-badge {
		position: absolute;
		top: -2px;
		right: -2px;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #dc2626;
		border: 2px solid rgba(0, 0, 0, 0.3);
		pointer-events: none;
		animation: badge-appear 0.2s ease-out;
	}

	@keyframes badge-appear {
		from { transform: scale(0); opacity: 0; }
		to { transform: scale(1); opacity: 1; }
	}

	.session-rename-btn {
		opacity: 0;
		background: none;
		border: none;
		padding: 4px;
		cursor: pointer;
		color: #666;
		border-radius: 4px;
		transition: all 0.15s;
		flex-shrink: 0;
	}

	.session-dropdown-item:hover .session-rename-btn {
		opacity: 1;
	}

	.session-rename-btn:hover {
		background: #e0e0e0;
		color: #333;
	}

	.session-dropdown-item.editing {
		padding: 6px 10px;
	}

	.session-rename-input {
		flex: 1;
		padding: 4px 8px;
		border: 1px solid #0078d4;
		border-radius: 4px;
		font-size: 13px;
		outline: none;
	}

	.session-rename-save {
		background: none;
		border: none;
		padding: 4px;
		cursor: pointer;
		color: #0078d4;
		border-radius: 4px;
	}

	.session-rename-save:hover {
		background: #e8f4fc;
	}

	.session-delete-btn {
		opacity: 0;
		background: none;
		border: none;
		padding: 4px;
		cursor: pointer;
		color: #666;
		border-radius: 4px;
		transition: all 0.15s;
		flex-shrink: 0;
	}

	.session-dropdown-item:hover .session-delete-btn {
		opacity: 1;
	}

	.session-delete-btn:hover {
		background: #fee2e2;
		color: #dc2626;
	}

	.session-dropdown-item.deleting {
		padding: 8px 16px;
		justify-content: space-between;
	}

	.session-delete-label {
		font-size: 13px;
		color: #1b1b1b;
	}

	.session-delete-actions {
		display: flex;
		gap: 8px;
	}

	.session-delete-confirm {
		background: #dc2626;
		color: white;
		border: none;
		padding: 4px 12px;
		border-radius: 4px;
		font-size: 12px;
		cursor: pointer;
		font-weight: 500;
	}

	.session-delete-confirm:hover {
		background: #b91c1c;
	}

	.session-delete-cancel {
		background: none;
		color: #666;
		border: 1px solid #d0d0d0;
		padding: 4px 12px;
		border-radius: 4px;
		font-size: 12px;
		cursor: pointer;
	}

	.session-delete-cancel:hover {
		background: #f5f5f5;
		color: #333;
	}

	.session-delete-confirm:disabled,
	.session-delete-cancel:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	@media (hover: none) {
		.session-rename-btn,
		.session-delete-btn {
			opacity: 1;
		}
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

	@media (max-width: 480px) {
		.session-name {
			max-width: 120px;
		}
	}
</style>
