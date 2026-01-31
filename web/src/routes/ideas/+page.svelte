<script lang="ts">
	import { onMount } from 'svelte';
	import { StatusBadge, EmptyState, AuthOverlay } from '$lib/components';
	import { useAuth } from '$lib/hooks/useAuth.svelte';
	import * as api from '$lib/api/client';
	import type { IdeaStatus } from '$lib/types';

	const auth = useAuth();

	// State
	let ideas = $state<api.Idea[]>([]);
	let selectedIdea = $state<api.Idea | null>(null);
	let showCreateModal = $state(false);
	let filterStatus = $state<IdeaStatus | 'all'>('all');
	let searchQuery = $state('');
	let loading = $state(true);
	let error = $state<string | null>(null);
	let creatingIdea = $state(false);
	let startingResearch = $state(false);
	let editMode = $state(false);
	let savingIdea = $state(false);
	let deletingIdea = $state(false);
	let showDeleteConfirm = $state(false);

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

	// Load ideas on mount
	onMount(async () => {
		await loadIdeas();
	});

	async function loadIdeas() {
		loading = true;
		error = null;
		try {
			const result = await api.listIdeas();
			ideas = result.ideas;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load ideas';
		} finally {
			loading = false;
		}
	}

	const filteredIdeas = $derived(() => {
		return ideas.filter(idea => {
			const matchesStatus = filterStatus === 'all' || idea.status === filterStatus;
			const matchesSearch = !searchQuery ||
				idea.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
				idea.content.toLowerCase().includes(searchQuery.toLowerCase());
			return matchesStatus && matchesSearch;
		});
	});

	const statusCounts = $derived(() => {
		const counts: Record<string, number> = { all: ideas.length };
		ideas.forEach(idea => {
			counts[idea.status] = (counts[idea.status] || 0) + 1;
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
			alert(`Failed to save: ${e instanceof Error ? e.message : 'Unknown error'}`);
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
			alert(`Failed to delete: ${e instanceof Error ? e.message : 'Unknown error'}`);
		} finally {
			deletingIdea = false;
			showDeleteConfirm = false;
		}
	}

	async function updateIdeaStatus(idea: api.Idea, newStatus: IdeaStatus) {
		try {
			const updated = await api.updateIdea(idea.id, { status: newStatus });
			const index = ideas.findIndex(i => i.id === idea.id);
			if (index !== -1) {
				ideas[index] = { ...ideas[index], ...updated };
				if (selectedIdea?.id === idea.id) {
					selectedIdea = ideas[index];
				}
			}
		} catch (e) {
			console.error('Failed to update idea status:', e);
			alert(`Failed to update status: ${e instanceof Error ? e.message : 'Unknown error'}`);
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
			alert(`Failed to start research: ${e instanceof Error ? e.message : 'Unknown error'}`);
		} finally {
			startingResearch = false;
		}
	}

	function chatAboutIdea(idea: api.Idea) {
		// Navigate to home with idea context
		const context = `I'd like to discuss this idea:\n\n**${idea.title}**\n\n${idea.content}\n\nContext: ${idea.context || 'None provided'}`;
		// Store in session storage and redirect
		sessionStorage.setItem('copilot_context', context);
		window.location.href = '/';
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
			alert(`Failed to create idea: ${e instanceof Error ? e.message : 'Unknown error'}`);
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
			default: return '💡';
		}
	}
</script>

<svelte:head>
	<title>Ideas | Homer</title>
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
<div class="ideas-page">
	<!-- Header -->
	<header class="page-header">
		<div class="header-content">
			<div class="header-left">
				<a href="/" class="back-link">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
						<path d="M19 12H5M12 19l-7-7 7-7"/>
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
			<input type="text" placeholder="Search ideas..." bind:value={searchQuery} />
		</div>
		<div class="status-tabs">
			<button
				class="tab"
				class:active={filterStatus === 'all'}
				onclick={() => filterStatus = 'all'}
			>
				All <span class="tab-count">{statusCounts().all}</span>
			</button>
			<button
				class="tab"
				class:active={filterStatus === 'draft'}
				onclick={() => filterStatus = 'draft'}
			>
				Draft <span class="tab-count">{statusCounts().draft || 0}</span>
			</button>
			<button
				class="tab"
				class:active={filterStatus === 'review'}
				onclick={() => filterStatus = 'review'}
			>
				Review <span class="tab-count">{statusCounts().review || 0}</span>
			</button>
			<button
				class="tab"
				class:active={filterStatus === 'planning'}
				onclick={() => filterStatus = 'planning'}
			>
				Planning <span class="tab-count">{statusCounts().planning || 0}</span>
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
		{:else if filteredIdeas().length === 0}
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
			{#each filteredIdeas() as idea}
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
		<div class="modal" onclick={(e) => e.stopPropagation()}>
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
						<button class="icon-btn edit-btn" onclick={startEdit} title="Edit">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
								<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
								<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
							</svg>
						</button>
						<button class="icon-btn delete-btn" onclick={() => showDeleteConfirm = true} title="Delete">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
								<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
							</svg>
						</button>
					{/if}
					<button class="modal-close" onclick={closeIdea}>
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
				<div class="modal-body">
					<div class="modal-meta">
						<StatusBadge status={selectedIdea.status} size="md" />
						<span class="meta-sep">•</span>
						<span class="meta-date">{selectedIdea.timestamp}</span>
						<span class="meta-sep">•</span>
						<span class="meta-id">ID: {selectedIdea.id}</span>
					</div>

					<div class="modal-section">
						<h4>Content</h4>
						<p>{selectedIdea.content}</p>
					</div>

					{#if selectedIdea.context}
						<div class="modal-section">
							<h4>Context</h4>
							<p>{selectedIdea.context}</p>
						</div>
					{/if}

					{#if selectedIdea.link}
						<div class="modal-section">
							<h4>Link</h4>
							<a href={selectedIdea.link} target="_blank" rel="noopener noreferrer" class="idea-link">{selectedIdea.link}</a>
						</div>
					{/if}

					{#if selectedIdea.tags && selectedIdea.tags.length > 0}
						<div class="modal-section">
							<h4>Tags</h4>
							<div class="tags-list">
								{#each selectedIdea.tags as tag}
									<span class="tag">{tag}</span>
								{/each}
							</div>
						</div>
					{/if}

					{#if selectedIdea.notes}
						<div class="modal-section">
							<h4>Notes</h4>
							<p>{selectedIdea.notes}</p>
						</div>
					{/if}

					<div class="modal-section">
						<h4>Update Status</h4>
						<div class="status-buttons">
							{#each ['draft', 'review', 'planning', 'execution', 'archived'] as status}
								<button
									class="status-btn {status}"
									class:active={selectedIdea.status === status}
									onclick={() => updateIdeaStatus(selectedIdea, status as IdeaStatus)}
								>
									{status}
								</button>
							{/each}
						</div>
					</div>
				</div>

				<div class="modal-footer">
					<button class="secondary-btn" onclick={closeIdea}>Close</button>
					{#if selectedIdea && !selectedIdea.linkedThreadId && (selectedIdea.status === 'draft' || selectedIdea.status === 'review')}
						<button class="secondary-btn research-btn" onclick={() => selectedIdea && startResearch(selectedIdea)} disabled={startingResearch}>
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
								<circle cx="11" cy="11" r="8"/>
								<path d="M21 21l-4.35-4.35"/>
							</svg>
							{startingResearch ? 'Starting...' : 'Start Research'}
						</button>
					{/if}
					<button class="primary-btn" onclick={() => selectedIdea && chatAboutIdea(selectedIdea)}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
							<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
						</svg>
						Chat About This
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<!-- Create Idea Modal -->
{#if showCreateModal}
	<div class="modal-overlay" onclick={() => showCreateModal = false}>
		<div class="modal" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<h2>New Idea</h2>
				<button class="modal-close" onclick={() => showCreateModal = false}>
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
		padding: 20px;
		overflow-y: auto;
		flex: 1;
	}

	.modal-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin-bottom: 20px;
		font-size: 13px;
		color: #666;
	}

	.meta-sep {
		color: #ccc;
	}

	.modal-section {
		margin-bottom: 20px;
	}

	.modal-section:last-child {
		margin-bottom: 0;
	}

	.modal-section h4 {
		font-size: 12px;
		font-weight: 600;
		color: #888;
		text-transform: uppercase;
		margin: 0 0 8px 0;
	}

	.modal-section p {
		font-size: 14px;
		color: #1b1b1b;
		line-height: 1.6;
		margin: 0;
	}

	.status-buttons {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.status-btn {
		padding: 6px 12px;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		background: white;
		font-size: 13px;
		text-transform: capitalize;
		cursor: pointer;
		transition: all 0.15s;
	}

	.status-btn:hover {
		border-color: #0078d4;
	}

	.status-btn.active {
		background: #0078d4;
		border-color: #0078d4;
		color: white;
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

	/* Research button styling */
	.research-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		color: #107c10;
		border-color: #107c10;
	}

	.research-btn:hover:not(:disabled) {
		background: #e5f3e5;
	}

	.research-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
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

		.status-buttons {
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
	}
</style>
