<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { StatusBadge, EmptyState, AuthOverlay } from '$lib/components';
	import { useAuth } from '$lib/hooks/useAuth.svelte';
	import * as api from '$lib/api/client';
	import type { IdeaStatus } from '$lib/types';
	import { toast } from '$lib/stores/toasts.svelte';

	const auth = useAuth();

	// State
	let ideas = $state<api.Idea[]>([]);
	let selectedIdea = $state<api.Idea | null>(null);
	let showCreateModal = $state(false);
	let filterStatus = $state<'all' | 'active' | 'archived' | 'completed'>('all');
	let searchQuery = $state('');
	let loading = $state(true);
	let error = $state<string | null>(null);
	let creatingIdea = $state(false);
	let startingResearch = $state(false);
	let startingExploration = $state(false);
	let editMode = $state(false);
	let savingIdea = $state(false);
	let deletingIdea = $state(false);
	let showDeleteConfirm = $state(false);
	let updatingStatus = $state(false);

	// Edit form state
	let editForm = $state({
		title: '',
		content: '',
		context: '',
		link: '',
		tags: ''
	});

	// New idea form state
	let newIdea = $state({
		title: '',
		content: '',
		context: '',
		source: 'user-request'
	});

	// Request versioning to prevent race conditions
	let loadVersion = $state(0);

	// Load ideas on mount
	onMount(async () => {
		await loadIdeas();
	});

	async function loadIdeas() {
		const thisVersion = ++loadVersion;
		loading = true;
		error = null;
		try {
			const result = await api.listIdeas();
			// Only apply result if this is still the latest request
			if (thisVersion === loadVersion) {
				ideas = result.ideas;
			}
		} catch (e) {
			if (thisVersion === loadVersion) {
				error = e instanceof Error ? e.message : 'Failed to load ideas';
			}
		} finally {
			if (thisVersion === loadVersion) {
				loading = false;
			}
		}
	}

	// Map legacy statuses to simplified statuses
	function mapLegacyStatus(status: string): 'active' | 'archived' | 'completed' {
		if (status === 'archived') return 'archived';
		if (status === 'completed') return 'completed';
		return 'active'; // everything else (draft, research, researching, exploring, review, planning, execution)
	}

	const filteredIdeas = $derived.by(() => {
		return ideas.filter(idea => {
			// Hide ideas that are linked to plans - they should be viewed in Plans tab
			if (idea.linkedPlanId) return false;

			const normalizedStatus = mapLegacyStatus(idea.status);
			const matchesStatus = filterStatus === 'all' || normalizedStatus === filterStatus;
			const matchesSearch = !searchQuery ||
				idea.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
				idea.content.toLowerCase().includes(searchQuery.toLowerCase());
			return matchesStatus && matchesSearch;
		});
	});

	function getSourceLabel(source: string): string {
		switch (source) {
			case 'user-request': return 'User';
			case 'claude-research': return 'Claude';
			case 'web-ui': return 'Web';
			case 'bookmark': return 'Bookmark';
			case 'youtube-analysis': return 'YouTube';
			default: return 'Idea';
		}
	}

	const statusCounts = $derived.by(() => {
		const visibleIdeas = ideas.filter(idea => !idea.linkedPlanId);
		const counts: Record<string, number> = { all: visibleIdeas.length, active: 0, archived: 0, completed: 0 };
		visibleIdeas.forEach(idea => {
			const normalizedStatus = mapLegacyStatus(idea.status);
			counts[normalizedStatus] = (counts[normalizedStatus] || 0) + 1;
		});
		return counts;
	});

	function openIdea(idea: api.Idea) {
		selectedIdea = idea;
		editMode = false;
		showDeleteConfirm = false;
	}

	function closeIdea() {
		selectedIdea = null;
		editMode = false;
		showDeleteConfirm = false;
	}

	function startEdit() {
		if (!selectedIdea) return;
		editForm = {
			title: selectedIdea.title,
			content: selectedIdea.content,
			context: selectedIdea.context || '',
			link: selectedIdea.link || '',
			tags: selectedIdea.tags?.join(', ') || ''
		};
		editMode = true;
	}

	function cancelEdit() {
		editMode = false;
	}

	async function saveEdit() {
		if (!selectedIdea || !editForm.title.trim() || !editForm.content.trim()) return;
		savingIdea = true;

		try {
			const tags = editForm.tags
				.split(',')
				.map(t => t.trim())
				.filter(t => t.length > 0);

			const updated = await api.updateIdea(selectedIdea.id, {
				title: editForm.title,
				content: editForm.content,
				context: editForm.context || undefined,
				link: editForm.link || undefined,
				tags: tags.length > 0 ? tags : undefined
			});

			// Update local state
			const index = ideas.findIndex(i => i.id === selectedIdea!.id);
			if (index !== -1) {
				ideas[index] = { ...ideas[index], ...updated, content: editForm.content, context: editForm.context, link: editForm.link, tags };
				selectedIdea = ideas[index];
			}

			editMode = false;
		} catch (e) {
			console.error('Failed to save idea:', e);
			toast.error(`Failed to save: ${e instanceof Error ? e.message : 'Unknown error'}`);
		} finally {
			savingIdea = false;
		}
	}

	async function deleteIdea() {
		if (!selectedIdea) return;
		deletingIdea = true;

		try {
			await api.deleteIdea(selectedIdea.id);
			ideas = ideas.filter(i => i.id !== selectedIdea!.id);
			closeIdea();
		} catch (e) {
			console.error('Failed to delete idea:', e);
			toast.error(`Failed to delete: ${e instanceof Error ? e.message : 'Unknown error'}`);
		} finally {
			deletingIdea = false;
			showDeleteConfirm = false;
		}
	}

	async function updateIdeaStatus(idea: api.Idea, newStatus: IdeaStatus, closeAfter = false) {
		if (closeAfter) updatingStatus = true;
		try {
			const updated = await api.updateIdea(idea.id, { status: newStatus });
			const index = ideas.findIndex(i => i.id === idea.id);
			if (index !== -1) {
				ideas[index] = { ...ideas[index], ...updated };
				if (selectedIdea?.id === idea.id) {
					selectedIdea = ideas[index];
				}
			}
			if (closeAfter) {
				const label = newStatus === 'archived' ? 'Idea archived' : newStatus === 'completed' ? 'Idea completed' : `Status updated to ${newStatus}`;
				toast.success(label);
				closeIdea();
			}
		} catch (e) {
			console.error('Failed to update idea status:', e);
			toast.error(`Failed to update status: ${e instanceof Error ? e.message : 'Unknown error'}`);
		} finally {
			updatingStatus = false;
		}
	}

	async function startResearch(idea: api.Idea) {
		startingResearch = true;
		try {
			const result = await api.startIdeaResearch(idea.id);
			// Navigate to chat with the new thread
			sessionStorage.setItem('resume_session', JSON.stringify({
				sessionId: result.sessionId,
				threadId: result.threadId
			}));
			window.location.href = '/';
		} catch (e) {
			console.error('Failed to start research:', e);
			toast.error(`Failed to start research: ${e instanceof Error ? e.message : 'Unknown error'}`);
		} finally {
			startingResearch = false;
		}
	}

	async function startExploration(idea: api.Idea) {
		startingExploration = true;
		try {
			const result = await api.startIdeaExploration(idea.id);
			// Navigate to chat with the exploration thread
			sessionStorage.setItem('resume_session', JSON.stringify({
				sessionId: result.sessionId,
				threadId: result.threadId
			}));
			if (result.resumed) {
				toast.success('Resuming exploration thread');
			}
			window.location.href = '/';
		} catch (e) {
			console.error('Failed to start exploration:', e);
			toast.error(`Failed to start exploration: ${e instanceof Error ? e.message : 'Unknown error'}`);
		} finally {
			startingExploration = false;
		}
	}


	async function createIdea() {
		if (!newIdea.title.trim() || !newIdea.content.trim()) return;
		creatingIdea = true;

		try {
			const result = await api.createIdea({
				title: newIdea.title,
				content: newIdea.content,
				context: newIdea.context || undefined,
				source: newIdea.source
			});

			// Reload ideas to get the new one with full data
			await loadIdeas();
			showCreateModal = false;
			newIdea = { title: '', content: '', context: '', source: 'user-request' };
		} catch (e) {
			console.error('Failed to create idea:', e);
			toast.error(`Failed to create idea: ${e instanceof Error ? e.message : 'Unknown error'}`);
		} finally {
			creatingIdea = false;
		}
	}

	function formatDate(timestamp: string | undefined) {
		if (!timestamp) return '';
		const date = new Date(timestamp.replace(' ', 'T'));
		return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	}

	function getSourceIcon(source: string) {
		switch (source) {
			case 'user-request': return '👤';
			case 'claude-research': return '🤖';
			case 'web-ui': return '🌐';
			case 'bookmark': return '🔖';
			case 'youtube-analysis': return '📺';
			default: return '💡';
		}
	}

	/** Extract Source Files section from context (youtube-analysis ideas). */
	function parseSourceFiles(context: string | undefined): Array<{label: string, path: string}> | null {
		if (!context) return null;
		const marker = '## Source Files\n';
		if (!context.startsWith(marker)) return null;
		const body = context.slice(marker.length);
		const end = body.indexOf('\n## ');
		const block = end === -1 ? body : body.slice(0, end);
		const files: Array<{label: string, path: string}> = [];
		for (const line of block.split('\n')) {
			const m = line.match(/^- (.+?):\s*`(.+?)`/);
			if (m) files.push({ label: m[1]!, path: m[2]! });
		}
		return files.length > 0 ? files : null;
	}

	/** Strip the ## Source Files block from context for normal display. */
	function stripSourceFiles(context: string | undefined): string | undefined {
		if (!context) return context;
		const marker = '## Source Files\n';
		if (!context.startsWith(marker)) return context;
		const body = context.slice(marker.length);
		const end = body.indexOf('\n## ');
		return end === -1 ? undefined : body.slice(end + 1).trim();
	}
</script>

<svelte:head>
	<title>Ideas | Microsoft Azure</title>
</svelte:head>

<svelte:window onkeydown={(e) => {
	if (e.key === 'Escape') {
		if (showDeleteConfirm) showDeleteConfirm = false;
		else if (editMode) cancelEdit();
		else if (selectedIdea) closeIdea();
		else if (showCreateModal) showCreateModal = false;
	}
}} />

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
<div class="ideas-page">
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
				<h1>Ideas</h1>
				<span class="count">{ideas.length}</span>
			</div>
			<button class="create-btn" onclick={() => showCreateModal = true}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
					<path d="M12 5v14M5 12h14"/>
				</svg>
				New Idea
			</button>
		</div>
	</header>

	<!-- Filters -->
	<div class="filters">
		<div class="search-box">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
				<circle cx="11" cy="11" r="8"/>
				<path d="M21 21l-4.35-4.35"/>
			</svg>
			<input type="text" placeholder="Search ideas..." bind:value={searchQuery} aria-label="Search ideas" />
		</div>
		<div class="status-tabs">
			<button
				class="tab"
				class:active={filterStatus === 'all'}
				onclick={() => filterStatus = 'all'}
			>
				All <span class="tab-count">{statusCounts.all}</span>
			</button>
			<button
				class="tab"
				class:active={filterStatus === 'active'}
				onclick={() => filterStatus = 'active'}
			>
				Active <span class="tab-count">{statusCounts.active || 0}</span>
			</button>
			<button
				class="tab"
				class:active={filterStatus === 'archived'}
				onclick={() => filterStatus = 'archived'}
			>
				Archived <span class="tab-count">{statusCounts.archived || 0}</span>
			</button>
			<button
				class="tab"
				class:active={filterStatus === 'completed'}
				onclick={() => filterStatus = 'completed'}
			>
				Completed <span class="tab-count">{statusCounts.completed || 0}</span>
			</button>
		</div>
	</div>

	<!-- Error banner -->
	{#if error}
		<div class="error-banner">
			<span>{error}</span>
			<button onclick={() => error = null}>Dismiss</button>
		</div>
	{/if}

	<!-- Ideas List -->
	<div class="ideas-list">
		{#if loading}
			<div class="loading">Loading ideas...</div>
		{:else if filteredIdeas.length === 0}
			<EmptyState
				icon="ideas"
				title="No ideas found"
				description={searchQuery ? "Try a different search term" : "Create your first idea to get started"}
			>
				{#if !searchQuery}
					<button class="empty-action-btn" onclick={() => showCreateModal = true}>
						Create Idea
					</button>
				{/if}
			</EmptyState>
		{:else}
			{#each filteredIdeas as idea}
				<button class="idea-card" onclick={() => openIdea(idea)}>
					<div class="idea-header">
						<span class="idea-source">{getSourceIcon(idea.source)}</span>
						<h3 class="idea-title">{idea.title}</h3>
						<StatusBadge status={idea.status} />
					</div>
					<p class="idea-content">{idea.content}</p>
					<div class="idea-footer">
						<span class="idea-date">{formatDate(idea.timestamp || idea.createdAt)}</span>
						<span class="idea-id">#{idea.id}</span>
					</div>
				</button>
			{/each}
		{/if}
	</div>
</div>

<!-- Idea Detail Modal -->
{#if selectedIdea}
	<div class="modal-overlay" onclick={closeIdea}>
		<div class="modal" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				{#if editMode}
					<h2>Edit Idea</h2>
				{:else}
					<div class="modal-title-row">
						<span class="modal-source">{getSourceIcon(selectedIdea.source)}</span>
						<h2>{selectedIdea.title}</h2>
					</div>
				{/if}
				<div class="modal-header-actions">
					{#if !editMode}
						<button class="icon-btn edit-btn" onclick={startEdit} title="Edit" aria-label="Edit idea">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
								<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
								<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
							</svg>
						</button>
						<button class="icon-btn delete-btn" onclick={() => showDeleteConfirm = true} title="Delete" aria-label="Delete idea">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
								<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
							</svg>
						</button>
					{/if}
					<button class="modal-close" onclick={closeIdea} aria-label="Close">
						<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
							<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
						</svg>
					</button>
				</div>
			</div>

			{#if showDeleteConfirm}
				<div class="delete-confirm">
					<p>Are you sure you want to delete this idea? This cannot be undone.</p>
					<div class="delete-confirm-actions">
						<button class="secondary-btn" onclick={() => showDeleteConfirm = false}>Cancel</button>
						<button class="danger-btn" onclick={deleteIdea} disabled={deletingIdea}>
							{deletingIdea ? 'Deleting...' : 'Delete'}
						</button>
					</div>
				</div>
			{:else if editMode}
				<div class="modal-body">
					<div class="form-group">
						<label for="edit-title">Title</label>
						<input
							type="text"
							id="edit-title"
							bind:value={editForm.title}
							placeholder="What's your idea?"
						/>
					</div>

					<div class="form-group">
						<label for="edit-content">Content</label>
						<textarea
							id="edit-content"
							bind:value={editForm.content}
							placeholder="Describe your idea..."
							rows="5"
						></textarea>
					</div>

					<div class="form-group">
						<label for="edit-context">Context</label>
						<textarea
							id="edit-context"
							bind:value={editForm.context}
							placeholder="Why is this relevant?"
							rows="2"
						></textarea>
					</div>

					<div class="form-group">
						<label for="edit-link">Link (optional)</label>
						<input
							type="url"
							id="edit-link"
							bind:value={editForm.link}
							placeholder="https://..."
						/>
					</div>

					<div class="form-group">
						<label for="edit-tags">Tags (comma-separated)</label>
						<input
							type="text"
							id="edit-tags"
							bind:value={editForm.tags}
							placeholder="tag1, tag2, tag3"
						/>
					</div>
				</div>

				<div class="modal-footer">
					<button class="secondary-btn" onclick={cancelEdit}>Cancel</button>
					<button
						class="primary-btn"
						onclick={saveEdit}
						disabled={!editForm.title.trim() || !editForm.content.trim() || savingIdea}
					>
						{savingIdea ? 'Saving...' : 'Save Changes'}
					</button>
				</div>
			{:else}
				<!-- Compact meta bar -->
				<div class="modal-meta-bar">
					<StatusBadge status={selectedIdea.status} size="sm" />
					<span class="meta-source">{getSourceIcon(selectedIdea.source)} {getSourceLabel(selectedIdea.source)}</span>
					<span class="meta-dot">&middot;</span>
					<span class="meta-date">{formatDate(selectedIdea.timestamp || selectedIdea.createdAt)}</span>
					<span class="meta-dot">&middot;</span>
					<span class="meta-id">#{selectedIdea.id}</span>
					{#if selectedIdea.linkedThreadId}
						<span class="thread-indicator">Research</span>
					{/if}
					{#if selectedIdea.linkedExplorationThreadId}
						<span class="thread-indicator">Exploration</span>
					{/if}
				</div>

				<div class="modal-body">
					<!-- Primary: Content -->
					<div class="idea-reading-area">{selectedIdea.content}</div>

					<!-- Source Files (youtube-analysis ideas) -->
					{#if selectedIdea.source === 'youtube-analysis' && selectedIdea.context}
						{@const sourceFiles = parseSourceFiles(selectedIdea.context)}
						{#if sourceFiles && sourceFiles.length > 0}
							<div class="idea-secondary-section">
								<div class="idea-secondary-label">Source Files</div>
								<div class="source-files-list">
									{#each sourceFiles as file}
										<div class="source-file-item">
											<span class="source-file-label">{file.label}:</span>
											<code class="source-file-path">{file.path}</code>
										</div>
									{/each}
								</div>
							</div>
						{/if}
					{/if}

					<!-- Secondary: Context -->
					{#if selectedIdea.context}
						{@const displayContext = selectedIdea.source === 'youtube-analysis'
							? stripSourceFiles(selectedIdea.context)
							: selectedIdea.context}
						{#if displayContext}
							<div class="idea-secondary-section">
								<div class="idea-secondary-label">Context</div>
								<div class="idea-secondary-content">{displayContext}</div>
							</div>
						{/if}
					{/if}

					<!-- Secondary: Exploration Notes -->
					{#if selectedIdea.exploration}
						<div class="idea-secondary-section">
							<div class="idea-secondary-label">Exploration Notes</div>
							<div class="idea-secondary-content exploration-content">{selectedIdea.exploration}</div>
						</div>
					{/if}

					<!-- Secondary: Notes -->
					{#if selectedIdea.notes}
						<div class="idea-secondary-section">
							<div class="idea-secondary-label">Notes</div>
							<div class="idea-secondary-content">{selectedIdea.notes}</div>
						</div>
					{/if}

					<!-- Secondary: Link -->
					{#if selectedIdea.link}
						<div class="idea-secondary-section">
							<div class="idea-secondary-label">Link</div>
							<a href={selectedIdea.link} target="_blank" rel="noopener noreferrer" class="idea-link">{selectedIdea.link}</a>
						</div>
					{/if}

					<!-- Tags -->
					{#if selectedIdea.tags && selectedIdea.tags.length > 0}
						<div class="idea-secondary-section">
							<div class="tags-list">
								{#each selectedIdea.tags as tag}
									<span class="tag">{tag}</span>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Linked Plan -->
					{#if selectedIdea.linkedPlanId}
						<div class="idea-secondary-section">
							<a href="/plans?id={selectedIdea.linkedPlanId}" class="plan-link">
								View Plan: {selectedIdea.linkedPlanId}
							</a>
						</div>
					{/if}

					<!-- Status Actions -->
					<div class="idea-secondary-section">
						<div class="status-actions">
							{#if mapLegacyStatus(selectedIdea.status) !== 'archived'}
								<button
									class="status-action-btn archive"
									onclick={() => selectedIdea && updateIdeaStatus(selectedIdea, 'archived', true)}
									disabled={updatingStatus}
								>
									{updatingStatus ? 'Updating...' : 'Archive'}
								</button>
							{/if}
							{#if mapLegacyStatus(selectedIdea.status) !== 'completed'}
								<button
									class="status-action-btn complete"
									onclick={() => selectedIdea && updateIdeaStatus(selectedIdea, 'completed', true)}
									disabled={updatingStatus}
								>
									{updatingStatus ? 'Updating...' : 'Complete'}
								</button>
							{/if}
						</div>
					</div>
				</div>

				<div class="modal-footer">
					<button class="secondary-btn" onclick={closeIdea}>Close</button>
					<button class="primary-btn" onclick={() => selectedIdea && startExploration(selectedIdea)} disabled={startingExploration}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
							<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
						</svg>
						{startingExploration ? 'Opening...' : (selectedIdea?.linkedExplorationThreadId ? 'Resume Talk' : 'Talk About This')}
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<!-- Create Idea Modal -->
{#if showCreateModal}
	<div class="modal-overlay" onclick={() => showCreateModal = false}>
		<div class="modal" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<h2>New Idea</h2>
				<button class="modal-close" onclick={() => showCreateModal = false} aria-label="Close">
					<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
						<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
					</svg>
				</button>
			</div>

			<div class="modal-body">
				<div class="form-group">
					<label for="title">Title</label>
					<input
						type="text"
						id="title"
						bind:value={newIdea.title}
						placeholder="What's your idea?"
					/>
				</div>

				<div class="form-group">
					<label for="content">Description</label>
					<textarea
						id="content"
						bind:value={newIdea.content}
						placeholder="Describe your idea in detail..."
						rows="4"
					></textarea>
				</div>

				<div class="form-group">
					<label for="context">Context (optional)</label>
					<textarea
						id="context"
						bind:value={newIdea.context}
						placeholder="Why is this relevant? Any background info?"
						rows="2"
					></textarea>
				</div>

				<div class="form-group">
					<label for="source">Source</label>
					<select id="source" bind:value={newIdea.source}>
						<option value="user-request">User Request</option>
						<option value="claude-research">Claude Research</option>
						<option value="bookmark">Bookmark</option>
					</select>
				</div>
			</div>

			<div class="modal-footer">
				<button class="secondary-btn" onclick={() => showCreateModal = false}>Cancel</button>
				<button
					class="primary-btn"
					onclick={createIdea}
					disabled={!newIdea.title.trim() || !newIdea.content.trim() || creatingIdea}
				>
					{creatingIdea ? 'Creating...' : 'Create Idea'}
				</button>
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

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.ideas-page {
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

	/* Ideas List */
	.ideas-list {
		max-width: 1200px;
		margin: 0 auto;
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.idea-card {
		background: white;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		padding: 16px;
		text-align: left;
		cursor: pointer;
		transition: all 0.15s;
		width: 100%;
	}

	.idea-card:hover {
		border-color: #0078d4;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
	}

	.idea-header {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 8px;
	}

	.idea-source {
		font-size: 16px;
	}

	.idea-title {
		flex: 1;
		font-size: 15px;
		font-weight: 600;
		color: #1b1b1b;
		margin: 0;
	}

	.idea-content {
		font-size: 13px;
		color: #666;
		line-height: 1.5;
		margin: 0 0 12px 0;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.idea-footer {
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
		max-width: 600px;
		max-height: 90vh;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 20px;
		border-bottom: 1px solid #e0e0e0;
	}

	.modal-header-actions {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.icon-btn {
		background: none;
		border: none;
		padding: 6px;
		cursor: pointer;
		color: #666;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s;
	}

	.icon-btn:hover {
		background: #f0f0f0;
		color: #1b1b1b;
	}

	.icon-btn.delete-btn:hover {
		background: #fef2f2;
		color: #dc2626;
	}

	.icon-btn.edit-btn:hover {
		background: #e8f4fc;
		color: #0078d4;
	}

	.modal-title-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.modal-source {
		font-size: 20px;
	}

	.modal-header h2 {
		font-size: 18px;
		font-weight: 600;
		margin: 0;
		color: #1b1b1b;
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
		padding: 20px 24px;
		overflow-y: auto;
		flex: 1;
		min-height: 0;

		/* Firefox scrollbar */
		scrollbar-width: thin;
		scrollbar-color: rgba(0, 0, 0, 0.15) transparent;

		/* Scroll shadows — pure CSS, no JS */
		background:
			linear-gradient(to bottom, #ffffff 30%, rgba(255, 255, 255, 0)) center top / 100% 40px no-repeat local,
			linear-gradient(to top, #ffffff 30%, rgba(255, 255, 255, 0)) center bottom / 100% 40px no-repeat local,
			linear-gradient(to bottom, rgba(0, 0, 0, 0.06), transparent) center top / 100% 12px no-repeat scroll,
			linear-gradient(to top, rgba(0, 0, 0, 0.06), transparent) center bottom / 100% 12px no-repeat scroll;
	}

	/* Webkit scrollbar (Chrome, Safari, Edge) */
	.modal-body::-webkit-scrollbar {
		width: 6px;
	}

	.modal-body::-webkit-scrollbar-track {
		background: transparent;
		margin: 4px 0;
	}

	.modal-body::-webkit-scrollbar-thumb {
		background-color: rgba(0, 0, 0, 0.15);
		border-radius: 3px;
	}

	.modal-body::-webkit-scrollbar-thumb:hover {
		background-color: rgba(0, 0, 0, 0.3);
	}

	.modal-meta-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		padding: 8px 20px;
		font-size: 12px;
		color: #888;
		border-bottom: 1px solid #f0f0f0;
	}

	.meta-dot {
		color: #ccc;
	}

	.idea-reading-area {
		font-size: 15px;
		line-height: 1.7;
		color: #1b1b1b;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.idea-secondary-section {
		margin-top: 20px;
		padding-top: 16px;
		border-top: 1px solid #f0f0f0;
	}

	.idea-secondary-label {
		font-size: 11px;
		font-weight: 600;
		color: #999;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		margin-bottom: 6px;
	}

	.idea-secondary-content {
		font-size: 14px;
		line-height: 1.6;
		color: #444;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.status-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.status-action-btn {
		padding: 8px 16px;
		border: 1px solid;
		border-radius: 4px;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s;
	}

	.status-action-btn.archive {
		color: #92400e;
		background: #fffbeb;
		border-color: #f59e0b;
	}

	.status-action-btn.archive:hover {
		background: #fef3c7;
	}

	.status-action-btn.complete {
		color: #065f46;
		background: #ecfdf5;
		border-color: #10b981;
	}

	.status-action-btn.complete:hover {
		background: #d1fae5;
	}

	.meta-source {
		font-size: 12px;
		color: #888;
	}

	.thread-indicator {
		font-size: 11px;
		color: #6b7280;
		background: #f3f4f6;
		padding: 2px 8px;
		border-radius: 10px;
	}

	.exploration-content {
		font-size: 14px;
		color: #1b1b1b;
		line-height: 1.6;
		white-space: pre-wrap;
		margin: 0;
	}

	.source-files-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.source-file-item {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex-wrap: wrap;
	}

	.source-file-label {
		font-size: 12px;
		color: #888;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.source-file-path {
		font-family: 'Cascadia Code', 'Consolas', 'SF Mono', monospace;
		font-size: 12px;
		color: #0078d4;
		background: #f0f6ff;
		padding: 2px 6px;
		border-radius: 3px;
		word-break: break-all;
		user-select: all;
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

	.primary-btn:hover:not(:disabled) {
		background: #006cbe;
	}

	.primary-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Form */
	.form-group {
		margin-bottom: 16px;
	}

	.form-group:last-child {
		margin-bottom: 0;
	}

	.form-group label {
		display: block;
		font-size: 13px;
		font-weight: 500;
		color: #1b1b1b;
		margin-bottom: 6px;
	}

	.form-group input,
	.form-group textarea,
	.form-group select {
		width: 100%;
		padding: 10px 12px;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		font-size: 14px;
		font-family: inherit;
		transition: border-color 0.15s;
	}

	.form-group input:focus,
	.form-group textarea:focus,
	.form-group select:focus {
		outline: none;
		border-color: #0078d4;
	}

	.form-group textarea {
		resize: vertical;
	}

	.empty-action-btn {
		padding: 8px 16px;
		background: #0078d4;
		color: white;
		border: none;
		border-radius: 4px;
		font-size: 14px;
		cursor: pointer;
	}

	.empty-action-btn:hover {
		background: #006cbe;
	}

	/* Plan link styling */
	.plan-link {
		color: #0078d4;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		background: #e5f1fb;
		border-radius: 4px;
		font-size: 14px;
	}

	.plan-link:hover {
		background: #cce4f7;
	}

	/* Delete confirmation */
	.delete-confirm {
		padding: 24px 20px;
		background: #fef2f2;
		border-bottom: 1px solid #fecaca;
	}

	.delete-confirm p {
		color: #b91c1c;
		margin: 0 0 16px 0;
		font-size: 14px;
	}

	.delete-confirm-actions {
		display: flex;
		gap: 12px;
		justify-content: flex-end;
	}

	.danger-btn {
		padding: 8px 16px;
		border: none;
		border-radius: 4px;
		background: #dc2626;
		color: white;
		font-size: 14px;
		cursor: pointer;
		transition: all 0.15s;
	}

	.danger-btn:hover:not(:disabled) {
		background: #b91c1c;
	}

	.danger-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Tags */
	.tags-list {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.tag {
		background: #e5f1fb;
		color: #0078d4;
		padding: 4px 10px;
		border-radius: 12px;
		font-size: 12px;
	}

	/* Link */
	.idea-link {
		color: #0078d4;
		text-decoration: none;
		word-break: break-all;
	}

	.idea-link:hover {
		text-decoration: underline;
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

		.status-actions {
			justify-content: center;
		}
	}

	@media (max-width: 480px) {
		.page-header {
			padding: 0 12px;
		}

		.ideas-list {
			padding: 16px 12px;
		}

		.status-tabs {
			flex-wrap: wrap;
		}

		.modal-footer {
			flex-direction: column;
		}

		.modal-footer button {
			width: 100%;
		}

		.status-actions {
			flex-direction: column;
		}

		.status-action-btn {
			width: 100%;
			text-align: center;
		}

		.icon-btn {
			padding: 10px;
		}
	}

	/* Focus-visible styles */
	button:focus-visible,
	a:focus-visible,
	input:focus-visible,
	select:focus-visible,
	textarea:focus-visible {
		outline: 2px solid #0078d4;
		outline-offset: 2px;
	}

	/* Disabled status action buttons */
	.status-action-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
