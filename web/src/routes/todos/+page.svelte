<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { AuthOverlay } from '$lib/components';
	import { useAuth } from '$lib/hooks/useAuth.svelte';
	import * as api from '$lib/api/client';
	import { toast } from '$lib/stores/toasts.svelte';

	const auth = useAuth();

	// State
	let todos = $state<api.Todo[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let filter = $state<'all' | 'work' | 'life'>('all');
	let showDone = $state(false);
	let expandedId = $state<string | null>(null);
	let composerOpen = $state(false);
	let composerTitle = $state('');
	let composerCategory = $state<api.TodoCategory>('W');
	let composerPriority = $state<api.TodoPriority>('P3');
	let savingId = $state<string | null>(null);
	let creating = $state(false);

	// Per-row dirty buffers (only the expanded row matters)
	let buffer = $state<{
		title: string;
		notes: string;
		category: api.TodoCategory;
		priority: api.TodoPriority;
		status: api.TodoStatus;
		dirty: boolean;
	} | null>(null);

	// Closing note buffer for the Mark-done flow (only used when buffer.status flips to 'done').
	let closingNote = $state('');

	const PRIO_COLOR: Record<api.TodoPriority, string> = {
		P1: '#dc2626',
		P2: '#ea580c',
		P3: '#2563eb'
	};
	const PRIO_RANK: Record<api.TodoPriority, number> = { P1: 0, P2: 1, P3: 2 };

	onMount(async () => {
		await load();
	});

	async function load() {
		loading = true;
		error = null;
		try {
			const r = await api.listTodos({ status: 'all', includeNotes: true, limit: 200 });
			todos = r.todos;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load to-dos';
		} finally {
			loading = false;
		}
	}

	// ── Derived collections ─────────────────────────────────────
	const openWork = $derived(
		todos
			.filter((t) => t.status === 'open' && t.category === 'W')
			.sort((a, b) => PRIO_RANK[a.priority] - PRIO_RANK[b.priority])
	);
	const openLife = $derived(
		todos
			.filter((t) => t.status === 'open' && t.category === 'L')
			.sort((a, b) => PRIO_RANK[a.priority] - PRIO_RANK[b.priority])
	);
	const doneTodos = $derived(
		todos
			.filter((t) => t.status === 'done')
			.sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
	);
	const showWork = $derived(filter !== 'life');
	const showLife = $derived(filter !== 'work');
	const totalOpen = $derived(openWork.length + openLife.length);

	// ── Expand / collapse ───────────────────────────────────────
	function toggle(t: api.Todo) {
		if (expandedId === t.id) {
			collapse();
			return;
		}
		expandedId = t.id;
		buffer = {
			title: t.title,
			notes: t.notes ?? '',
			category: t.category,
			priority: t.priority,
			status: t.status,
			dirty: false
		};
		closingNote = '';
	}
	function collapse() {
		expandedId = null;
		buffer = null;
		closingNote = '';
	}

	function markDirty() {
		if (buffer) buffer.dirty = true;
	}

	// ── Save / cancel ───────────────────────────────────────────
	async function save(t: api.Todo) {
		if (!buffer) return;
		savingId = t.id;
		try {
			// If the user is flipping open → done in this session and wrote a closing
			// note, append it under a `## Completed YYYY-MM-DD` heading so it lives
			// inside the canonical notes.
			let finalNotes = buffer.notes;
			const flippingToDone = t.status !== 'done' && buffer.status === 'done';
			const note = closingNote.trim();
			if (flippingToDone && note.length > 0) {
				const today = new Date().toISOString().slice(0, 10);
				const heading = `## Completed ${today}`;
				const trimmedBase = finalNotes.replace(/\s+$/, '');
				finalNotes = trimmedBase.length > 0
					? `${trimmedBase}\n\n${heading}\n${note}`
					: `${heading}\n${note}`;
			}
			const r = await api.updateTodo(t.id, {
				title: buffer.title,
				notes: finalNotes,
				category: buffer.category,
				priority: buffer.priority,
				status: buffer.status
			});
			todos = todos.map((x) => (x.id === t.id ? r.todo : x));
			collapse();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Save failed');
		} finally {
			savingId = null;
		}
	}

	// Intent only — flips buffer.status and reveals the closing-note box.
	// Actual transition to done happens on Save.
	function requestDone() {
		if (!buffer) return;
		if (buffer.status === 'done') {
			buffer.status = 'open';
			closingNote = '';
		} else {
			buffer.status = 'done';
			setTimeout(() => {
				const el = document.getElementById('closing-note-input') as HTMLTextAreaElement | null;
				el?.focus();
			}, 0);
		}
		buffer.dirty = true;
	}

	function cancel() {
		collapse();
	}

	// ── Mark done inline (no closing note slide-in; closing thought lives in notes) ──
	async function toggleDone(t: api.Todo) {
		savingId = t.id;
		try {
			const newStatus: api.TodoStatus = t.status === 'done' ? 'open' : 'done';
			const r = await api.updateTodo(t.id, { status: newStatus });
			todos = todos.map((x) => (x.id === t.id ? r.todo : x));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Update failed');
		} finally {
			savingId = null;
		}
	}

	// ── Composer ────────────────────────────────────────────────
	function openComposer() {
		composerOpen = true;
		composerTitle = '';
		composerCategory = filter === 'life' ? 'L' : 'W';
		composerPriority = 'P3';
		queueFocusComposer();
	}
	function queueFocusComposer() {
		setTimeout(() => {
			const el = document.getElementById('composer-input') as HTMLInputElement | null;
			el?.focus();
		}, 150);
	}
	function hideComposer() {
		composerOpen = false;
	}
	async function commitNew() {
		const title = composerTitle.trim();
		if (!title) {
			hideComposer();
			return;
		}
		creating = true;
		try {
			const r = await api.createTodo({
				title,
				category: composerCategory,
				priority: composerPriority
			});
			todos = [...todos, r.todo];
			hideComposer();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Create failed');
		} finally {
			creating = false;
		}
	}

	// ── Start a chat ───────────────────────────────────────────
	let startingChat = $state(false);
	async function startChat(t: api.Todo) {
		startingChat = true;
		try {
			const r = await api.startTodoThread(t.id);
			// Prefill the composer with a blockquoted view of the todo so the user
			// can edit/append before sending. Cursor lands on the trailing blank line.
			const lines: string[] = [`> **${t.title}**`];
			if (t.notes && t.notes.trim().length > 0) {
				lines.push('>');
				for (const line of t.notes.split('\n')) {
					lines.push(`> ${line}`);
				}
			}
			lines.push('', '');
			const prefill = lines.join('\n');

			// Long notes can blow past safe URL lengths — hand off via sessionStorage
			// when that risk exists; main page reads it in the same onMount branch.
			const qs = new URLSearchParams({ session: r.sessionId, thread: r.threadId });
			if (prefill.length > 1500) {
				sessionStorage.setItem('resume_session', JSON.stringify({
					sessionId: r.sessionId,
					threadId: r.threadId,
				}));
				sessionStorage.setItem('pending_prefill', prefill);
				goto('/');
			} else {
				qs.set('prefill', prefill);
				goto(`/?${qs}`);
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to start chat');
		} finally {
			startingChat = false;
		}
	}

	// ── Delete (hard, irreversible) ────────────────────────────
	// Gated by a confirm modal — `confirmDeleteFor` holds the target todo while open.
	let confirmDeleteFor = $state<api.Todo | null>(null);
	let deleting = $state(false);
	function requestDelete(t: api.Todo) { confirmDeleteFor = t; }
	function cancelDelete() { if (!deleting) confirmDeleteFor = null; }
	async function confirmDelete() {
		if (!confirmDeleteFor) return;
		const target = confirmDeleteFor;
		deleting = true;
		try {
			await api.deleteTodo(target.id);
			todos = todos.filter((x) => x.id !== target.id);
			if (expandedId === target.id) collapse();
			toast.success('Todo deleted');
			confirmDeleteFor = null;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Delete failed');
		} finally {
			deleting = false;
		}
	}
</script>

{#if !auth.user}
	<AuthOverlay />
{:else}
	<div class="todos-page">
		<header class="page-header">
			<div class="header-content">
				<div class="header-left">
					<a class="back-btn" href="/" title="Back">←</a>
					<a class="azure-logo-link" href="/">
						<svg class="azure-icon" viewBox="0 0 23 23" fill="none" xmlns="http://www.w3.org/2000/svg">
							<path
								d="M0 19.32h22.97L11.49 0 0 19.32zm12.6-2.97l-1.11-1.86 1.11-2.18 1.11 2.18-1.11 1.86z"
								fill="currentColor"
							/>
						</svg>
					</a>
					<h1>To-Dos <span class="count">{totalOpen} open</span></h1>
				</div>
			</div>
		</header>

		<div class="container">
			<!-- Toolbar -->
			<div class="toolbar">
				<button
					class="tab"
					class:active={filter === 'all'}
					onclick={() => (filter = 'all')}
				>
					<span class="tab-badge A">A</span>
					<span>All</span>
					<span class="tab-count">{totalOpen}</span>
				</button>
				<button
					class="tab"
					class:active={filter === 'work'}
					onclick={() => (filter = 'work')}
				>
					<span class="tab-badge W">W</span>
					<span>Work</span>
					<span class="tab-count">{openWork.length}</span>
				</button>
				<button
					class="tab"
					class:active={filter === 'life'}
					onclick={() => (filter = 'life')}
				>
					<span class="tab-badge L">L</span>
					<span>Life</span>
					<span class="tab-count">{openLife.length}</span>
				</button>
				<div class="toolbar-spacer"></div>
				<button class="add-btn" onclick={openComposer} disabled={composerOpen}>
					<span class="plus">+</span> New to-do
				</button>
			</div>

			<!-- Composer -->
			{#if composerOpen}
				<div class="composer" style="--prio: {PRIO_COLOR[composerPriority]}">
					<input
						id="composer-input"
						type="text"
						placeholder="New to-do…  (Enter to save · Esc to cancel)"
						bind:value={composerTitle}
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								commitNew();
							} else if (e.key === 'Escape') {
								e.preventDefault();
								hideComposer();
							}
						}}
					/>
					<div class="composer-divider"></div>
					<div class="cat-controls">
						<button
							class="cat-badge W"
							class:active={composerCategory === 'W'}
							onclick={() => (composerCategory = 'W')}
							title="Work">W</button
						>
						<button
							class="cat-badge L"
							class:active={composerCategory === 'L'}
							onclick={() => (composerCategory = 'L')}
							title="Life">L</button
						>
					</div>
					<div class="composer-divider"></div>
					<div class="composer-prio">
						<button
							class="composer-dot"
							class:active={composerPriority === 'P1'}
							style="background: {PRIO_COLOR.P1}"
							onclick={() => (composerPriority = 'P1')}
							title="P1 (urgent)"
							aria-label="P1"
						></button>
						<button
							class="composer-dot"
							class:active={composerPriority === 'P2'}
							style="background: {PRIO_COLOR.P2}"
							onclick={() => (composerPriority = 'P2')}
							title="P2 (soon)"
							aria-label="P2"
						></button>
						<button
							class="composer-dot"
							class:active={composerPriority === 'P3'}
							style="background: {PRIO_COLOR.P3}"
							onclick={() => (composerPriority = 'P3')}
							title="P3 (later · default)"
							aria-label="P3"
						></button>
					</div>
					<button
						class="composer-go"
						onclick={commitNew}
						disabled={creating || !composerTitle.trim()}
						title="Save"
						aria-label="Save"
					></button>
					<button class="composer-cancel" onclick={hideComposer} title="Cancel" aria-label="Cancel">×</button>
				</div>
			{/if}

			{#if loading}
				<div class="loading">Loading…</div>
			{:else if error}
				<div class="error-banner">{error}</div>
			{:else}
				{#if showWork}
					<section class="section">
						<div class="section-header">
							<span><span class="section-badge W">W</span>Work {openWork.length ? `· ${openWork.length}` : ''}</span>
						</div>
						<div class="list">
							{#each openWork as t (t.id)}
								{@render row(t)}
							{/each}
							{#if openWork.length === 0}
								<div class="empty">No open work to-dos.</div>
							{/if}
						</div>
					</section>
				{/if}

				{#if showLife}
					<section class="section">
						<div class="section-header">
							<span><span class="section-badge L">L</span>Life {openLife.length ? `· ${openLife.length}` : ''}</span>
						</div>
						<div class="list">
							{#each openLife as t (t.id)}
								{@render row(t)}
							{/each}
							{#if openLife.length === 0}
								<div class="empty">No open life to-dos.</div>
							{/if}
						</div>
					</section>
				{/if}

				<section class="section">
					<button
						class="section-header toggle-done"
						onclick={() => (showDone = !showDone)}
						type="button"
					>
						<span>Done {doneTodos.length ? `· ${doneTodos.length}` : ''}</span>
						<span class="chevron" class:open={showDone}>▼</span>
					</button>
					{#if showDone}
						<div class="list">
							{#each doneTodos as t (t.id)}
								{@render row(t)}
							{/each}
							{#if doneTodos.length === 0}
								<div class="empty">Nothing done yet.</div>
							{/if}
						</div>
					{/if}
				</section>
			{/if}
		</div>
	</div>
{/if}

{#if confirmDeleteFor}
	<div
		class="modal-backdrop"
		role="dialog"
		aria-modal="true"
		aria-labelledby="confirm-delete-title"
		onclick={cancelDelete}
		onkeydown={(e) => { if (e.key === 'Escape') cancelDelete(); }}
		tabindex="-1"
	>
		<div class="modal-card" role="document" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} tabindex="-1">
			<h2 id="confirm-delete-title" class="modal-title">Delete this to-do?</h2>
			<p class="modal-body">
				<strong>{confirmDeleteFor.title}</strong>
			</p>
			<p class="modal-sub">This is irreversible. Notes and history will be permanently lost.</p>
			<div class="modal-actions">
				<button class="btn btn-cancel" onclick={cancelDelete} disabled={deleting} type="button">Cancel</button>
				<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting} type="button" autofocus>
					{deleting ? 'Deleting…' : 'Delete'}
				</button>
			</div>
		</div>
	</div>
{/if}

{#snippet row(t: api.Todo)}
	{@const expanded = expandedId === t.id}
	{@const isDone = t.status === 'done'}
	<div
		class="row"
		class:expanded
		class:done-item={isDone}
		style="--prio: {PRIO_COLOR[t.priority]}"
	>
		<div class="row-header">
			<button
				class="row-check"
				class:checked={isDone}
				onclick={(e) => {
					e.stopPropagation();
					toggleDone(t);
				}}
				title={isDone ? 'Mark open' : 'Mark done'}
				disabled={savingId === t.id}
				aria-label={isDone ? 'Mark open' : 'Mark done'}
			></button>
			{#if expanded && buffer}
				<input
					class="row-title row-title-edit"
					bind:value={buffer.title}
					oninput={markDirty}
					placeholder="Title"
					onclick={(e) => e.stopPropagation()}
					onkeydown={(e) => {
						if (e.key === 'Enter') { e.preventDefault(); save(t); }
						else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
					}}
				/>
			{:else}
				<button class="row-title" onclick={() => toggle(t)} type="button">
					{t.title}
				</button>
			{/if}
			<span class="row-cat-badge cat-badge-{t.category}">{t.category}</span>
			<span class="row-prio-pill prio-{t.priority}">{t.priority}</span>
			<button
				class="row-chat"
				onclick={(e) => {
					e.stopPropagation();
					startChat(t);
				}}
				disabled={startingChat}
				title="Start a chat from this to-do"
				aria-label="Start a chat"
			>💬</button>
			<button class="row-toggle" onclick={() => toggle(t)} type="button" aria-label="Expand">
				<span class="toggle-chevron">▼</span>
			</button>
		</div>

		{#if expanded && buffer}
			<div class="row-body" onclick={(e) => e.stopPropagation()} role="region" aria-label="To-do details">
				<div class="toggles-row">
					<div class="toggle-group">
						<span class="toggle-label">Category</span>
						<div class="toggle-controls">
							<button
								class="cat-badge W"
								class:active={buffer.category === 'W'}
								onclick={() => {
									buffer!.category = 'W';
									markDirty();
								}}
								title="Work">W</button
							>
							<button
								class="cat-badge L"
								class:active={buffer.category === 'L'}
								onclick={() => {
									buffer!.category = 'L';
									markDirty();
								}}
								title="Life">L</button
							>
						</div>
					</div>
					<div class="toggle-group">
						<span class="toggle-label">Priority</span>
						<div class="toggle-controls prio-pills">
							{#each ['P1', 'P2', 'P3'] as p}
								<button
									class="pill prio-{p}"
									class:active={buffer.priority === p}
									onclick={() => {
										buffer!.priority = p as api.TodoPriority;
										markDirty();
									}}
								>
									<span class="pill-dot" style="background: {PRIO_COLOR[p as api.TodoPriority]}"></span>{p}
								</button>
							{/each}
						</div>
					</div>
					<div class="toggle-group">
						<span class="toggle-label">Status</span>
						<div class="toggle-controls">
							<button
								class="btn-mark-done"
								class:pending={buffer.status === 'done' && t.status !== 'done'}
								class:reopen={buffer.status === 'open' && t.status === 'done'}
								class:already-done={buffer.status === 'done' && t.status === 'done'}
								onclick={requestDone}
								type="button"
								title={buffer.status === 'done' ? 'Reopen this to-do' : 'Mark this to-do done — Save to commit'}
							>
								{#if buffer.status === 'done'}
									<span class="mark-check checked">✓</span> Done
								{:else}
									<span class="mark-check"></span> Mark done
								{/if}
							</button>
						</div>
					</div>
					<!-- Spacer pushes Delete to the far right so it's hard to click by accident. -->
					<div class="toggle-spacer"></div>
					<div class="toggle-group toggle-group-delete">
						<span class="toggle-label">Danger</span>
						<div class="toggle-controls">
							<button
								class="btn-delete"
								onclick={() => requestDelete(t)}
								type="button"
								title="Delete this to-do (irreversible)"
								aria-label="Delete to-do"
							>
								<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<path d="M3 6h18"/>
									<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
									<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
								</svg>
								Delete
							</button>
						</div>
					</div>
				</div>

				{#if buffer.status === 'done' && t.status !== 'done'}
					<div class="closing-note" role="region" aria-label="Closing note">
						<label class="closing-note-label" for="closing-note-input">
							Closing note <span class="closing-note-hint">(optional — added under <code>## Completed</code> in notes)</span>
						</label>
						<textarea
							id="closing-note-input"
							class="closing-note-input"
							bind:value={closingNote}
							placeholder="What got done? Any closing thought, learning, or follow-up?"
						></textarea>
					</div>
				{/if}

				<textarea
					class="notes-area"
					bind:value={buffer.notes}
					oninput={markDirty}
					placeholder="Notes — anything you want to remember."
				></textarea>

				<div class="row-footer">
					<span class="meta-tiny">{t.id}</span>
					<div class="footer-spacer"></div>
					<button class="btn btn-cancel" onclick={cancel} type="button">Cancel</button>
					<button
						class="btn btn-save"
						class:dirty={buffer.dirty}
						onclick={() => save(t)}
						disabled={savingId === t.id}
						type="button"
					>
						{savingId === t.id ? 'Saving…' : 'Save'}
					</button>
				</div>
			</div>
		{/if}
	</div>
{/snippet}

<style>
	.todos-page {
		min-height: 100vh;
		background: #f2f2f2;
		font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
		color: #1b1b1b;
	}

	/* Header (matches plans page styling) */
	.page-header { background: #1b1b1b; height: 56px; padding: 0 24px; display: flex; align-items: center; }
	.header-content { width: 100%; display: flex; align-items: center; justify-content: space-between; }
	.header-left { display: flex; align-items: center; gap: 0; }
	.back-btn {
		display: flex; align-items: center; justify-content: center;
		width: 32px; height: 32px;
		background: rgba(255,255,255,0.10); border-radius: 6px; color: white;
		transition: all 0.2s ease; cursor: pointer;
		border: 1px solid rgba(255,255,255,0.15);
		margin-right: 8px; text-decoration: none; font-size: 14px;
	}
	.back-btn:hover {
		background: rgba(255,255,255,0.25);
		border-color: rgba(255,255,255,0.4);
		transform: translateX(-2px);
	}
	.azure-logo-link {
		display: flex; align-items: center;
		padding: 4px; border-radius: 4px;
		transition: all 0.2s ease; margin-right: 12px;
		text-decoration: none;
	}
	.azure-logo-link:hover { background: rgba(255,255,255,0.15); }
	.azure-icon { width: 20px; height: 20px; flex-shrink: 0; color: #0078d4; }
	.page-header h1 { color: white; font-size: 16px; font-weight: 600; margin: 0; }
	.count {
		background: rgba(255,255,255,0.25); color: white;
		font-size: 12px; padding: 2px 8px; border-radius: 10px; margin-left: 8px;
	}

	/* Container */
	.container { max-width: 1200px; margin: 24px auto 80px; padding: 0 24px; }

	/* Toolbar tabs (matches plans page .tab/.tab.active) */
	.toolbar {
		display: flex; align-items: center; gap: 4px; margin-bottom: 20px;
	}
	.tab {
		background: none; border: none;
		padding: 8px 16px; font-size: 13px;
		color: #666; cursor: pointer;
		border-radius: 4px; transition: all 0.15s;
		font-family: inherit; font-weight: 500;
		display: inline-flex; align-items: center; gap: 8px;
	}
	.tab:hover { background: #f0f0f0; }
	.tab.active { background: #e5f1fb; color: #0078d4; font-weight: 600; }
	.tab-badge {
		width: 16px; height: 16px; border-radius: 3px;
		display: inline-flex; align-items: center; justify-content: center;
		font-size: 9px; font-weight: 700; color: white;
	}
	.tab-badge.W { background: #1b1b1b; }
	.tab-badge.L { background: #16a34a; }
	.tab-badge.A { background: linear-gradient(135deg, #1b1b1b 50%, #16a34a 50%); }
	.tab .tab-count { font-size: 11px; color: #999; font-family: ui-monospace, Menlo, monospace; font-weight: 500; }
	.tab.active .tab-count { color: #0078d4; }
	.toolbar-spacer { flex: 1; }

	.add-btn {
		display: flex; align-items: center; gap: 6px;
		padding: 8px 16px; border: none; border-radius: 4px;
		background: #0078d4; color: white;
		font-size: 14px; font-weight: 500; cursor: pointer;
		font-family: inherit; transition: all 0.15s;
	}
	.add-btn:hover:not(:disabled) { background: #006cbe; }
	.add-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.add-btn .plus { font-size: 16px; line-height: 1; font-weight: 400; }

	/* Composer */
	.composer {
		background: white;
		border: 1.5px solid #0078d4; border-radius: 8px;
		padding: 10px 12px 10px 16px;
		display: flex; align-items: center; gap: 12px;
		box-shadow: 0 4px 12px rgba(0,120,212,0.10);
		position: relative;
		margin-bottom: 16px;
	}
	.composer::before {
		content: ''; position: absolute; left: 0; top: 0; bottom: 0;
		width: 3px; background: var(--prio, #2563eb);
		border-radius: 8px 0 0 8px;
	}
	.composer input {
		flex: 1; border: none; outline: none;
		font-size: 14px; font-family: inherit;
		color: #1b1b1b; background: transparent; padding: 4px 0;
	}
	.composer input::placeholder { color: #b0b0b0; }
	.composer-divider { width: 1px; height: 22px; background: #e0e0e0; }
	.cat-controls { display: flex; gap: 5px; }
	.composer-prio { display: flex; gap: 5px; }
	.composer-dot {
		width: 14px; height: 14px; border-radius: 50%;
		cursor: pointer; transition: transform 0.1s;
		opacity: 0.4; border: none; padding: 0;
	}
	.composer-dot:hover { transform: scale(1.15); opacity: 0.9; }
	.composer-dot.active {
		opacity: 1; outline: 1.5px solid #1b1b1b; outline-offset: 2px;
	}
	.composer-go {
		width: 28px; height: 28px; border-radius: 4px;
		background: #0078d4; color: white;
		display: flex; align-items: center; justify-content: center;
		cursor: pointer; border: none; transition: all 0.15s;
		position: relative;
	}
	.composer-go:hover:not(:disabled) { background: #006cbe; }
	.composer-go:disabled { opacity: 0.4; cursor: not-allowed; }
	.composer-go::after {
		content: '';
		width: 5px; height: 9px;
		border: solid white;
		border-width: 0 2px 2px 0;
		transform: rotate(45deg);
		margin-bottom: 1px;
	}
	.composer-cancel {
		background: none; border: none; color: #b0b0b0;
		font-size: 18px; cursor: pointer; line-height: 1; padding: 0 2px;
	}
	.composer-cancel:hover { color: #1b1b1b; }

	/* Cat badges */
	.cat-badge {
		width: 30px; height: 26px;
		border-radius: 4px;
		display: flex; align-items: center; justify-content: center;
		font-size: 12px; font-weight: 700;
		cursor: pointer; transition: all 0.12s;
		user-select: none;
		border: 1.5px solid #d4d4d4;
		background: white; color: #6b6b6b;
		font-family: inherit;
	}
	.cat-badge:hover { border-color: #1b1b1b; color: #1b1b1b; }
	.cat-badge.W.active { background: #1b1b1b; border-color: #1b1b1b; color: white; }
	.cat-badge.L.active { background: #16a34a; border-color: #16a34a; color: white; }

	/* Section headers */
	.section { margin-bottom: 28px; }
	.section-header {
		font-size: 12px; text-transform: uppercase; letter-spacing: 1.1px;
		color: #666; font-weight: 600;
		border-bottom: 1px solid #e0e0e0;
		padding-bottom: 8px; margin-bottom: 10px;
		display: flex; align-items: center; justify-content: space-between;
		user-select: none;
		background: none; border-left: none; border-right: none; border-top: none;
		width: 100%; text-align: left; font-family: inherit;
	}
	.section-badge {
		width: 16px; height: 16px; border-radius: 4px;
		margin-right: 8px;
		display: inline-flex; align-items: center; justify-content: center;
		font-size: 9px; font-weight: 700; color: white;
		vertical-align: text-bottom;
	}
	.section-badge.W { background: #1b1b1b; }
	.section-badge.L { background: #16a34a; }
	.section-header.toggle-done {
		cursor: pointer; margin-top: 36px;
		padding-top: 0; padding-left: 0; padding-right: 0;
	}
	.section-header.toggle-done:hover { color: #0078d4; }
	.chevron {
		display: inline-block; font-size: 9px;
		transition: transform 0.18s; transform: rotate(-90deg);
	}
	.chevron.open { transform: rotate(0deg); }

	.list { display: flex; flex-direction: column; gap: 8px; }
	.empty { color: #999; font-size: 13px; font-style: italic; padding: 16px 0; }

	/* Row */
	.row {
		background: white;
		border: 1px solid #e0e0e0;
		border-radius: 8px;
		position: relative; overflow: hidden;
		transition: box-shadow 0.15s ease, border-color 0.15s ease;
	}
	.row::before {
		content: ''; position: absolute; left: 0; top: 0; bottom: 0;
		width: 3px; background: var(--prio, #2563eb);
		z-index: 2; border-radius: 8px 0 0 8px;
	}
	.row:hover { border-color: #0078d4; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
	.row.expanded { border-color: #0078d4; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
	.row.expanded::before { width: 4px; }
	.row.done-item { opacity: 0.6; background: #fafafa; }
	.row.done-item .row-title { text-decoration: line-through; color: #888; }
	.row.done-item:hover { opacity: 0.9; }

	.row-header {
		padding: 12px 14px 12px 22px;
		display: flex; align-items: center; gap: 10px;
		user-select: none;
	}
	.row-check {
		width: 20px; height: 20px;
		border: 2px solid #c5c5c5; border-radius: 50%;
		display: flex; align-items: center; justify-content: center;
		transition: all 0.15s; background: white; flex-shrink: 0;
		cursor: pointer; padding: 0;
	}
	.row-check:hover { border-color: #16a34a; }
	.row-check.checked { border-color: #16a34a; background: #16a34a; position: relative; }
	.row-check.checked::after {
		content: ''; width: 5px; height: 9px;
		border: solid white; border-width: 0 2px 2px 0;
		transform: rotate(45deg); margin-bottom: 2px;
	}
	.row-title {
		flex: 1; text-align: left;
		background: none; border: none; padding: 0;
		font-size: 15px; font-weight: 500; color: #1b1b1b;
		font-family: inherit; cursor: pointer;
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.row-title-edit {
		flex: 1; text-align: left;
		background: transparent; padding: 6px 8px;
		border: 1px solid #e0e0e0; border-radius: 4px;
		font-size: 15px; font-weight: 500; color: #1b1b1b;
		font-family: inherit; outline: none;
		cursor: text; white-space: normal; overflow: visible; text-overflow: clip;
		transition: background 0.15s, border-color 0.15s;
		min-width: 0;
	}
	.row-title-edit:hover { border-color: #b0b0b0; }
	.row-title-edit:focus { background: #fdf6e3; border-color: #e7d9a8; }
	.row-cat-badge {
		width: 22px; height: 20px;
		border-radius: 3px;
		display: inline-flex; align-items: center; justify-content: center;
		font-size: 10px; font-weight: 700; color: white;
		flex-shrink: 0;
	}
	.cat-badge-W { background: #1b1b1b; }
	.cat-badge-L { background: #16a34a; }
	.row-prio-pill {
		font-size: 11px; font-weight: 600;
		padding: 2px 8px; border-radius: 10px;
		flex-shrink: 0;
	}
	.row-prio-pill.prio-P1 { background: #fee2e2; color: #b91c1c; }
	.row-prio-pill.prio-P2 { background: #ffedd5; color: #c2410c; }
	.row-prio-pill.prio-P3 { background: #dbeafe; color: #1d4ed8; }
	.row-chat, .row-toggle {
		background: none; border: none;
		padding: 2px 6px; cursor: pointer; color: #888;
		font-size: 14px; flex-shrink: 0;
	}
	.row-chat:hover { color: #0078d4; }
	.row-toggle:hover { color: #0078d4; }
	.toggle-chevron {
		display: inline-block; font-size: 10px; color: #b0b0b0;
		transition: transform 0.18s;
	}
	.row.expanded .toggle-chevron { transform: rotate(180deg); color: #0078d4; }

	.row-body {
		padding: 12px 24px 16px 24px;
		border-top: 1px solid #f0f0f0;
		display: flex; flex-direction: column; gap: 12px;
	}

	.toggles-row { display: flex; align-items: flex-start; gap: 22px; flex-wrap: wrap; }
	.toggle-group { display: flex; flex-direction: column; gap: 5px; }
	.toggle-label {
		font-size: 10px; color: #888;
		text-transform: uppercase; letter-spacing: 0.7px; font-weight: 600;
	}
	.toggle-controls { display: flex; gap: 6px; }

	.pill {
		padding: 5px 11px; height: 26px;
		font-size: 11.5px; font-weight: 600;
		border-radius: 14px;
		cursor: pointer;
		border: 1px solid #e0e0e0; background: white; color: #888;
		font-family: inherit;
		display: flex; align-items: center; gap: 5px;
		transition: all 0.1s;
	}
	.pill-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
	.pill:hover { color: #1b1b1b; border-color: #b0b0b0; }
	.pill.prio-P1.active { background: #fee2e2; border-color: #dc2626; color: #b91c1c; }
	.pill.prio-P2.active { background: #ffedd5; border-color: #ea580c; color: #c2410c; }
	.pill.prio-P3.active { background: #dbeafe; border-color: #2563eb; color: #1d4ed8; }

	.notes-area {
		width: 100%; min-height: 140px;
		border: 1px solid #e0e0e0; border-radius: 6px;
		padding: 12px 14px;
		font-size: 14px; line-height: 1.65;
		font-family: 'Segoe UI', sans-serif; color: #2a2a2a;
		background: white; resize: vertical; outline: none;
		transition: background 0.18s, border-color 0.18s;
	}
	.notes-area::placeholder { color: #c5c5c5; }
	.notes-area:focus { background: #fdf6e3; border-color: #e7d9a8; }

	.row-footer { display: flex; align-items: center; gap: 10px; }
	.footer-spacer { flex: 1; }
	.meta-tiny { font-size: 10.5px; color: #b0b0b0; font-family: ui-monospace, Menlo, monospace; }
	.btn {
		padding: 8px 16px; font-size: 14px;
		border-radius: 4px; cursor: pointer;
		font-family: inherit; font-weight: 500;
		border: 1px solid transparent; transition: all 0.15s;
	}
	.btn-cancel { background: white; border-color: #e0e0e0; color: #666; }
	.btn-cancel:hover { background: #f5f5f5; color: #1b1b1b; }
	.btn-save { background: #0078d4; border-color: #0078d4; color: white; }
	.btn-save:hover:not(:disabled) { background: #006cbe; }
	.btn-save:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-save.dirty {
		background: #16a34a; border-color: #16a34a;
		box-shadow: 0 2px 8px rgba(22,163,74,0.25);
	}
	.btn-save.dirty:hover:not(:disabled) { background: #15803d; }
	/* Mark-done pill — lives in toggles-row, right of Priority. */
	.btn-mark-done {
		height: 26px; padding: 0 12px;
		display: inline-flex; align-items: center; gap: 6px;
		background: white; color: #6b6b6b;
		border: 1px solid #e0e0e0; border-radius: 14px;
		font-size: 11.5px; font-weight: 600;
		font-family: inherit; cursor: pointer;
		transition: all 0.12s;
	}
	.btn-mark-done:hover { border-color: #16a34a; color: #15803d; }
	.btn-mark-done .mark-check {
		display: inline-flex; align-items: center; justify-content: center;
		width: 14px; height: 14px; border-radius: 50%;
		border: 1.5px solid currentColor; background: transparent;
		font-size: 9px; font-weight: 700; line-height: 1;
		color: inherit;
	}
	/* Pending — user clicked Mark done but hasn't Saved yet. */
	.btn-mark-done.pending {
		background: #ecfdf5; border-color: #16a34a; color: #15803d;
		box-shadow: 0 0 0 3px rgba(22,163,74,0.10);
	}
	.btn-mark-done.pending .mark-check.checked {
		background: #16a34a; border-color: #16a34a; color: white;
	}
	/* Already done (user expanded a done todo) — neutral check styling. */
	.btn-mark-done.already-done {
		background: #f5f5f5; border-color: #d4d4d4; color: #666;
	}
	.btn-mark-done.already-done .mark-check.checked {
		background: #16a34a; border-color: #16a34a; color: white;
	}
	/* Reopen-pending — user clicked Reopen on a done todo, awaiting Save. */
	.btn-mark-done.reopen {
		background: white; border-color: #b0b0b0; color: #1b1b1b;
		box-shadow: 0 0 0 3px rgba(0,0,0,0.05);
	}

	/* Closing note box (slides in only when the user just clicked Mark done). */
	.closing-note {
		background: #ecfdf5;
		border: 1px solid #bbf7d0; border-radius: 6px;
		padding: 12px 14px; display: flex; flex-direction: column; gap: 6px;
	}
	.closing-note-label {
		font-size: 11px; font-weight: 600; color: #15803d;
		text-transform: uppercase; letter-spacing: 0.7px;
	}
	.closing-note-hint {
		text-transform: none; letter-spacing: 0; font-weight: 500;
		color: #56806e; margin-left: 4px;
	}
	.closing-note-hint code {
		background: rgba(22,163,74,0.10); padding: 1px 5px; border-radius: 3px;
		font-size: 11px;
	}
	.closing-note-input {
		width: 100%; min-height: 64px; resize: vertical;
		border: 1px solid #bbf7d0; border-radius: 4px;
		padding: 8px 10px; background: white;
		font-size: 14px; line-height: 1.55; font-family: inherit;
		color: #1b1b1b; outline: none;
		transition: border-color 0.15s;
	}
	.closing-note-input:focus { border-color: #16a34a; }

	/* Delete pill — far right of toggles-row, same 26px height as Status/Priority pills. */
	.toggle-spacer { flex: 1 1 auto; min-width: 24px; }
	.toggle-group-delete { align-items: flex-end; }
	.toggle-group-delete .toggle-label { color: #b91c1c; }
	.btn-delete {
		height: 26px; padding: 0 12px;
		display: inline-flex; align-items: center; gap: 6px;
		background: white; color: #b91c1c;
		border: 1px solid #fecaca; border-radius: 14px;
		font-size: 11.5px; font-weight: 600;
		font-family: inherit; cursor: pointer;
		transition: all 0.12s;
	}
	.btn-delete:hover {
		background: #fee2e2; border-color: #dc2626; color: #b91c1c;
		box-shadow: 0 0 0 3px rgba(220,38,38,0.08);
	}
	.btn-delete svg { flex-shrink: 0; }

	/* Confirm-delete modal */
	.modal-backdrop {
		position: fixed; inset: 0; z-index: 1000;
		background: rgba(0,0,0,0.45);
		display: flex; align-items: center; justify-content: center;
		padding: 24px;
		animation: modal-fade 0.12s ease-out;
	}
	.modal-card {
		background: white; border-radius: 10px;
		max-width: 440px; width: 100%;
		padding: 22px 22px 18px;
		box-shadow: 0 18px 48px rgba(0,0,0,0.25);
		border-top: 4px solid #dc2626;
		animation: modal-pop 0.14s ease-out;
	}
	.modal-title {
		margin: 0 0 10px; font-size: 16px; font-weight: 700; color: #1b1b1b;
	}
	.modal-body {
		margin: 0 0 6px; font-size: 14px; color: #1b1b1b;
		word-break: break-word;
	}
	.modal-sub {
		margin: 0 0 18px; font-size: 12.5px; color: #6b6b6b; line-height: 1.45;
	}
	.modal-actions {
		display: flex; justify-content: flex-end; gap: 8px;
	}
	.btn-danger {
		background: #dc2626; border-color: #dc2626; color: white;
	}
	.btn-danger:hover:not(:disabled) {
		background: #b91c1c; border-color: #b91c1c;
	}
	.btn-danger:disabled { opacity: 0.6; cursor: not-allowed; }
	@keyframes modal-fade {
		from { opacity: 0; }
		to   { opacity: 1; }
	}
	@keyframes modal-pop {
		from { opacity: 0; transform: scale(0.96) translateY(4px); }
		to   { opacity: 1; transform: scale(1) translateY(0); }
	}

	.loading { color: #666; padding: 48px; text-align: center; }
	.error-banner {
		background: #fef2f2; border: 1px solid #fecaca;
		color: #b91c1c; padding: 12px 16px; border-radius: 6px;
		margin-bottom: 16px;
	}
</style>
