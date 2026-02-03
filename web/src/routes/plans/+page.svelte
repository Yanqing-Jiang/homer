<script lang="ts">
	import { onMount } from 'svelte';
	import { StatusBadge, ProgressBar, EmptyState, AuthOverlay } from '$lib/components';
	import { useAuth } from '$lib/hooks/useAuth.svelte';
	import * as api from '$lib/api/client';
	import type { PlanStatus } from '$lib/types';
	import { toast } from '$lib/stores/toasts.svelte';

	const auth = useAuth();

	// State
	let plans = $state<api.Plan[]>([]);
	let selectedPlan = $state<api.PlanDetail | null>(null);
	let expandedPhases = $state<Set<number>>(new Set([0]));
	let filterStatus = $state<PlanStatus | 'all'>('all');
	let loading = $state(true);
	let error = $state<string | null>(null);
	let togglingTask = $state(false);
	let startingWork = $state(false);

	// Edit mode state
	let editMode = $state(false);
	let savingPlan = $state(false);
	let editForm = $state({
		title: '',
		description: '',
		status: '',
		phases: [] as api.PlanPhase[]
	});

	// Load plans on mount
	onMount(async () => {
		await loadPlans();
	});

	async function loadPlans() {
		loading = true;
		error = null;
		try {
			const result = await api.listPlans();
			plans = result.plans;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load plans';
		} finally {
			loading = false;
		}
	}

	const filteredPlans = $derived(() => {
		if (filterStatus === 'all') return plans;
		return plans.filter(p => p.status === filterStatus);
	});

	function calculateProgress(plan: api.Plan): number {
		if (plan.totalTasks && plan.completedTasks !== undefined) {
			if (plan.totalTasks === 0) return 0;
			return Math.round((plan.completedTasks / plan.totalTasks) * 100);
		}
		const allTasks = plan.phases.flatMap(p => p.tasks);
		if (allTasks.length === 0) return 0;
		const completed = allTasks.filter(t => t.completed).length;
		return Math.round((completed / allTasks.length) * 100);
	}

	function calculatePhaseProgress(phase: { tasks: { completed: boolean }[] }): number {
		if (phase.tasks.length === 0) return 0;
		const completed = phase.tasks.filter(t => t.completed).length;
		return Math.round((completed / phase.tasks.length) * 100);
	}

	// Track pending plan selection to prevent out-of-order responses
	let pendingPlanId = $state<string | null>(null);

	async function openPlan(plan: api.Plan) {
		pendingPlanId = plan.id;
		try {
			const detail = await api.getPlan(plan.id);
			// Only apply if this is still the plan we're waiting for
			if (pendingPlanId === plan.id) {
				selectedPlan = detail;
				expandedPhases = new Set([0]);
			}
		} catch (e) {
			if (pendingPlanId === plan.id) {
				console.error('Failed to load plan details:', e);
				error = e instanceof Error ? e.message : 'Failed to load plan';
			}
		}
	}

	function closePlan() {
		selectedPlan = null;
		editMode = false;
	}

	function startEdit() {
		if (!selectedPlan) return;
		editForm = {
			title: selectedPlan.title,
			description: selectedPlan.description || '',
			status: selectedPlan.status,
			phases: JSON.parse(JSON.stringify(selectedPlan.phases)) // Deep copy
		};
		editMode = true;
	}

	function cancelEdit() {
		editMode = false;
	}

	async function savePlan() {
		if (!selectedPlan || !editForm.title.trim()) return;
		savingPlan = true;

		try {
			const updated = await api.updatePlan(selectedPlan.id, {
				title: editForm.title,
				description: editForm.description || undefined,
				status: editForm.status,
				phases: editForm.phases
			});

			// Update local state
			selectedPlan = { ...selectedPlan, ...updated };

			// Update in plans list
			const planIndex = plans.findIndex(p => p.id === selectedPlan?.id);
			if (planIndex !== -1) {
				plans[planIndex] = { ...plans[planIndex], ...updated };
			}

			editMode = false;
		} catch (e) {
			console.error('Failed to save plan:', e);
			toast.error(`Failed to save: ${e instanceof Error ? e.message : 'Unknown error'}`);
		} finally {
			savingPlan = false;
		}
	}

	function addPhase() {
		editForm.phases = [...editForm.phases, { name: 'New Phase', status: 'pending', tasks: [] }];
	}

	function removePhase(index: number) {
		editForm.phases = editForm.phases.filter((_, i) => i !== index);
	}

	function addTask(phaseIndex: number) {
		const phase = editForm.phases[phaseIndex];
		if (phase) {
			phase.tasks = [...phase.tasks, { text: 'New task', completed: false }];
			editForm.phases = [...editForm.phases];
		}
	}

	function removeTask(phaseIndex: number, taskIndex: number) {
		const phase = editForm.phases[phaseIndex];
		if (phase) {
			phase.tasks = phase.tasks.filter((_, i) => i !== taskIndex);
			editForm.phases = [...editForm.phases];
		}
	}

	function togglePhase(index: number) {
		if (expandedPhases.has(index)) {
			expandedPhases.delete(index);
		} else {
			expandedPhases.add(index);
		}
		expandedPhases = new Set(expandedPhases);
	}

	// Track which task is being toggled using compound identifier
	let togglingTaskKey = $state<string | null>(null);

	function getTaskKey(phaseIndex: number, taskIndex: number, taskText: string): string {
		return `${phaseIndex}-${taskIndex}-${taskText}`;
	}

	async function toggleTask(phaseIndex: number, taskIndex: number) {
		if (!selectedPlan || togglingTask) return;

		const task = selectedPlan.phases[phaseIndex].tasks[taskIndex];
		const newCompleted = !task.completed;
		const taskKey = getTaskKey(phaseIndex, taskIndex, task.text);

		togglingTask = true;
		togglingTaskKey = taskKey;

		try {
			const updated = await api.togglePlanTask(selectedPlan.id, task.text, newCompleted);

			// Only apply if this is the task we expected to toggle
			if (togglingTaskKey === taskKey) {
				// Update local state
				selectedPlan = {
					...selectedPlan,
					phases: updated.phases
				};

				// Update in the plans list too
				const planIndex = plans.findIndex(p => p.id === selectedPlan?.id);
				if (planIndex !== -1) {
					plans[planIndex] = { ...plans[planIndex], phases: updated.phases };
				}
			}
		} catch (e) {
			console.error('Failed to toggle task:', e);
			toast.error(`Failed to update task: ${e instanceof Error ? e.message : 'Unknown error'}`);
		} finally {
			if (togglingTaskKey === taskKey) {
				togglingTask = false;
				togglingTaskKey = null;
			}
		}
	}

	async function startWork() {
		if (!selectedPlan || startingWork) return;

		startingWork = true;
		try {
			const result = await api.createPlanWorkThread(selectedPlan.id);
			// Navigate to chat with the new thread
			sessionStorage.setItem('resume_session', JSON.stringify({
				sessionId: result.sessionId,
				threadId: result.threadId
			}));
			window.location.href = '/';
		} catch (e) {
			console.error('Failed to create work thread:', e);
			toast.error(`Failed to start work session: ${e instanceof Error ? e.message : 'Unknown error'}`);
		} finally {
			startingWork = false;
		}
	}

	function getPhaseIcon(status: string) {
		switch (status) {
			case 'completed': return '✓';
			case 'in_progress': return '▶';
			default: return '○';
		}
	}
</script>

<svelte:head>
	<title>Plans | Homer</title>
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
<div class="plans-page">
	<!-- Header -->
	<header class="page-header">
		<div class="header-content">
			<div class="header-left">
				<a href="/" class="back-link">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
						<path d="M19 12H5M12 19l-7-7 7-7"/>
					</svg>
				</a>
				<h1>Plans</h1>
				<span class="count">{plans.length}</span>
			</div>
		</div>
	</header>

	<!-- Filters -->
	<div class="filters">
		<div class="status-tabs">
			<button
				class="tab"
				class:active={filterStatus === 'all'}
				onclick={() => filterStatus = 'all'}
			>
				All
			</button>
			<button
				class="tab"
				class:active={filterStatus === 'planning'}
				onclick={() => filterStatus = 'planning'}
			>
				Planning
			</button>
			<button
				class="tab"
				class:active={filterStatus === 'execution'}
				onclick={() => filterStatus = 'execution'}
			>
				Execution
			</button>
			<button
				class="tab"
				class:active={filterStatus === 'completed'}
				onclick={() => filterStatus = 'completed'}
			>
				Completed
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

	<!-- Plans List -->
	<div class="plans-list">
		{#if loading}
			<div class="loading">Loading plans...</div>
		{:else if filteredPlans().length === 0}
			<EmptyState
				icon="plans"
				title="No plans found"
				description="Plans are created when ideas move to the planning stage"
			/>
		{:else}
			{#each filteredPlans() as plan}
				<button class="plan-card" onclick={() => openPlan(plan)}>
					<div class="plan-header">
						<h3 class="plan-title">{plan.title}</h3>
						<StatusBadge status={plan.status} />
					</div>

					<p class="plan-description">{plan.description || ''}</p>

					<div class="plan-progress">
						<div class="progress-label">
							<span>Progress</span>
							<span class="progress-percent">{calculateProgress(plan)}%</span>
						</div>
						<ProgressBar value={calculateProgress(plan)} color="blue" />
					</div>

					<div class="plan-meta">
						<span class="meta-item">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
								<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
								<line x1="16" y1="2" x2="16" y2="6"/>
								<line x1="8" y1="2" x2="8" y2="6"/>
								<line x1="3" y1="10" x2="21" y2="10"/>
							</svg>
							{plan.createdAt || 'Unknown'}
						</span>
						<span class="meta-item">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
								<path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
								<path d="M22 4L12 14.01l-3-3"/>
							</svg>
							{plan.phases.length} phases
						</span>
						{#if plan.currentPhase}
							<span class="meta-item current-phase">
								{plan.currentPhase}
							</span>
						{/if}
					</div>
				</button>
			{/each}
		{/if}
	</div>
</div>

<!-- Plan Detail Modal -->
{#if selectedPlan}
	<div class="modal-overlay" onclick={closePlan}>
		<div class="modal modal-large" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				{#if editMode}
					<div class="edit-title-row">
						<input
							type="text"
							class="title-input"
							bind:value={editForm.title}
							placeholder="Plan title"
						/>
					</div>
				{:else}
					<div>
						<h2>{selectedPlan.title}</h2>
						<p class="modal-subtitle">{selectedPlan.currentPhase}</p>
					</div>
				{/if}
				<div class="modal-header-right">
					{#if !editMode}
						<button class="icon-btn edit-btn" onclick={startEdit} title="Edit Plan">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
								<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
								<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
							</svg>
						</button>
						<StatusBadge status={selectedPlan.status} size="md" />
					{/if}
					<button class="modal-close" onclick={closePlan}>
						<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
							<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
						</svg>
					</button>
				</div>
			</div>

			{#if editMode}
			<div class="modal-body">
				<div class="edit-form">
					<div class="form-group">
						<label>Description</label>
						<textarea
							bind:value={editForm.description}
							placeholder="Plan description..."
							rows="3"
						></textarea>
					</div>

					<div class="form-group">
						<label>Status</label>
						<select bind:value={editForm.status}>
							<option value="planning">Planning</option>
							<option value="execution">Execution</option>
							<option value="completed">Completed</option>
						</select>
					</div>

					<div class="phases-editor">
						<div class="phases-editor-header">
							<label>Phases</label>
							<button class="add-btn" onclick={addPhase}>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
									<path d="M12 5v14M5 12h14"/>
								</svg>
								Add Phase
							</button>
						</div>

						{#each editForm.phases as phase, phaseIndex}
							<div class="phase-editor">
								<div class="phase-editor-header">
									<input
										type="text"
										class="phase-name-input"
										bind:value={phase.name}
										placeholder="Phase name"
									/>
									<button class="remove-btn" onclick={() => removePhase(phaseIndex)} title="Remove phase">
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
											<path d="M18 6L6 18M6 6l12 12"/>
										</svg>
									</button>
								</div>

								<div class="tasks-editor">
									{#each phase.tasks as task, taskIndex}
										<div class="task-editor">
											<input
												type="checkbox"
												bind:checked={task.completed}
											/>
											<input
												type="text"
												class="task-input"
												bind:value={task.text}
												placeholder="Task description"
											/>
											<button class="remove-btn small" onclick={() => removeTask(phaseIndex, taskIndex)}>
												<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
													<path d="M18 6L6 18M6 6l12 12"/>
												</svg>
											</button>
										</div>
									{/each}
									<button class="add-task-btn" onclick={() => addTask(phaseIndex)}>
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
											<path d="M12 5v14M5 12h14"/>
										</svg>
										Add Task
									</button>
								</div>
							</div>
						{/each}
					</div>
				</div>
			</div>

			<div class="modal-footer">
				<button class="secondary-btn" onclick={cancelEdit}>Cancel</button>
				<button class="primary-btn" onclick={savePlan} disabled={!editForm.title.trim() || savingPlan}>
					{savingPlan ? 'Saving...' : 'Save Changes'}
				</button>
			</div>
			{:else}
				<div class="modal-body">
				<!-- Overall Progress -->
				<div class="overall-progress">
					<div class="progress-header">
						<span>Overall Progress</span>
						<span class="progress-percent">{calculateProgress(selectedPlan)}%</span>
					</div>
					<ProgressBar value={calculateProgress(selectedPlan)} size="lg" color="blue" />
				</div>

				<!-- Phases Accordion -->
				<div class="phases-section">
					<h3>Phases</h3>
					<div class="phases-list">
						{#each selectedPlan.phases as phase, phaseIndex}
							<div class="phase-item">
								<button
									class="phase-header"
									class:expanded={expandedPhases.has(phaseIndex)}
									onclick={() => togglePhase(phaseIndex)}
								>
									<span class="phase-icon {phase.status}">{getPhaseIcon(phase.status)}</span>
									<span class="phase-name">{phase.name}</span>
									<div class="phase-progress">
										<span class="phase-progress-text">
											{phase.tasks.filter(t => t.completed).length}/{phase.tasks.length}
										</span>
										<ProgressBar
											value={calculatePhaseProgress(phase)}
											size="sm"
											color={phase.status === 'completed' ? 'green' : 'blue'}
										/>
									</div>
									<svg
										class="expand-icon"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										width="16"
										height="16"
									>
										<path d="M6 9l6 6 6-6"/>
									</svg>
								</button>

								{#if expandedPhases.has(phaseIndex)}
									<div class="phase-tasks">
										{#each phase.tasks as task, taskIndex}
											<label class="task-item">
												<input
													type="checkbox"
													checked={task.completed}
													onchange={() => toggleTask(phaseIndex, taskIndex)}
												/>
												<span class="task-checkmark">
													{#if task.completed}
														<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="12" height="12">
															<path d="M5 13l4 4L19 7"/>
														</svg>
													{/if}
												</span>
												<span class="task-text" class:completed={task.completed}>
													{task.text}
												</span>
											</label>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</div>

				<!-- Linked Threads -->
				{#if selectedPlan.threads && selectedPlan.threads.length > 0}
					<div class="threads-section">
						<h3>Linked Threads</h3>
						<div class="linked-threads">
							{#each selectedPlan.threads as thread}
								<div class="linked-thread">
									<span class="thread-provider">{thread.provider}</span>
									<span class="thread-title">{thread.title || 'Untitled'}</span>
									<StatusBadge status={thread.status} />
								</div>
							{/each}
						</div>
					</div>
				{/if}
				</div>

				<div class="modal-footer">
					<button class="secondary-btn" onclick={closePlan}>Close</button>
					<button class="primary-btn" onclick={startWork} disabled={startingWork}>
						<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
							<path d="M8 5v14l11-7z"/>
						</svg>
						{startingWork ? 'Starting...' : 'Start Work Session'}
					</button>
				</div>
			{/if}
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

	.plans-page {
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

	/* Filters */
	.filters {
		background: white;
		padding: 16px 24px;
		border-bottom: 1px solid #e0e0e0;
	}

	.status-tabs {
		display: flex;
		gap: 4px;
	}

	.tab {
		background: none;
		border: none;
		padding: 8px 16px;
		font-size: 13px;
		color: #666;
		cursor: pointer;
		border-radius: 4px;
		transition: all 0.15s;
	}

	.tab:hover {
		background: #f0f0f0;
	}

	.tab.active {
		background: #e5f1fb;
		color: #0078d4;
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

	/* Plans List */
	.plans-list {
		max-width: 1200px;
		margin: 0 auto;
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.plan-card {
		background: white;
		border: 1px solid #e0e0e0;
		border-radius: 8px;
		padding: 20px;
		text-align: left;
		cursor: pointer;
		transition: all 0.15s;
		width: 100%;
	}

	.plan-card:hover {
		border-color: #0078d4;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
	}

	.plan-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 12px;
	}

	.plan-title {
		font-size: 17px;
		font-weight: 600;
		color: #1b1b1b;
		margin: 0;
	}

	.plan-description {
		font-size: 14px;
		color: #666;
		line-height: 1.5;
		margin: 0 0 16px 0;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.plan-progress {
		margin-bottom: 16px;
	}

	.progress-label {
		display: flex;
		justify-content: space-between;
		font-size: 12px;
		color: #666;
		margin-bottom: 6px;
	}

	.progress-percent {
		font-weight: 600;
		color: #0078d4;
	}

	.plan-meta {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
		font-size: 12px;
		color: #888;
	}

	.meta-item {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.current-phase {
		color: #0078d4;
		font-weight: 500;
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

	.modal-large {
		max-width: 800px;
	}

	.modal-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		padding: 20px 24px;
		border-bottom: 1px solid #e0e0e0;
	}

	.modal-header h2 {
		font-size: 20px;
		font-weight: 600;
		margin: 0;
		color: #1b1b1b;
	}

	.modal-subtitle {
		font-size: 13px;
		color: #666;
		margin: 4px 0 0 0;
	}

	.modal-header-right {
		display: flex;
		align-items: center;
		gap: 12px;
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
		padding: 24px;
		overflow-y: auto;
		flex: 1;
	}

	.modal-footer {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
		padding: 16px 24px;
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

	/* Overall Progress */
	.overall-progress {
		margin-bottom: 24px;
	}

	.progress-header {
		display: flex;
		justify-content: space-between;
		font-size: 14px;
		color: #1b1b1b;
		margin-bottom: 8px;
	}

	/* Phases */
	.phases-section h3 {
		font-size: 14px;
		font-weight: 600;
		color: #1b1b1b;
		margin: 0 0 12px 0;
	}

	.phases-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.phase-item {
		border: 1px solid #e0e0e0;
		border-radius: 6px;
		overflow: hidden;
	}

	.phase-header {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 12px 16px;
		background: #fafafa;
		border: none;
		cursor: pointer;
		transition: background 0.15s;
		text-align: left;
	}

	.phase-header:hover {
		background: #f0f0f0;
	}

	.phase-icon {
		width: 20px;
		height: 20px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 10px;
		flex-shrink: 0;
	}

	.phase-icon.pending {
		background: #e5e5e5;
		color: #888;
	}

	.phase-icon.in_progress {
		background: #dbeafe;
		color: #1e40af;
	}

	.phase-icon.completed {
		background: #d1fae5;
		color: #065f46;
	}

	.phase-name {
		flex: 1;
		font-size: 14px;
		font-weight: 500;
		color: #1b1b1b;
	}

	.phase-progress {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 120px;
	}

	.phase-progress-text {
		font-size: 12px;
		color: #666;
		min-width: 32px;
	}

	.expand-icon {
		color: #666;
		transition: transform 0.2s;
	}

	.phase-header.expanded .expand-icon {
		transform: rotate(180deg);
	}

	.phase-tasks {
		padding: 12px 16px;
		background: white;
		border-top: 1px solid #e0e0e0;
	}

	.task-item {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 8px 0;
		cursor: pointer;
	}

	.task-item input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}

	.task-checkmark {
		flex-shrink: 0;
		width: 18px;
		height: 18px;
		border: 2px solid #d1d5db;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s;
		margin-top: 1px;
	}

	.task-checkmark svg {
		color: white;
	}

	.task-item:hover .task-checkmark {
		border-color: #0078d4;
	}

	.task-item input:checked + .task-checkmark {
		background: #0078d4;
		border-color: #0078d4;
	}

	.task-text {
		font-size: 14px;
		color: #1b1b1b;
		line-height: 1.4;
	}

	.task-text.completed {
		color: #888;
		text-decoration: line-through;
	}

	/* Edit Mode Styles */
	.icon-btn {
		background: none;
		border: none;
		padding: 6px;
		cursor: pointer;
		color: #666;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		transition: all 0.15s;
	}

	.icon-btn:hover {
		background: #f0f0f0;
		color: #1b1b1b;
	}

	.edit-btn {
		color: #0078d4;
	}

	.edit-btn:hover {
		background: #e5f1fb;
		color: #006cbe;
	}

	.edit-title-row {
		flex: 1;
	}

	.title-input {
		width: 100%;
		font-size: 20px;
		font-weight: 600;
		padding: 8px 12px;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		color: #1b1b1b;
	}

	.title-input:focus {
		outline: none;
		border-color: #0078d4;
		box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.1);
	}

	.edit-form {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.form-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.form-group label {
		font-size: 13px;
		font-weight: 600;
		color: #1b1b1b;
	}

	.form-group textarea {
		padding: 10px 12px;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		font-size: 14px;
		font-family: inherit;
		resize: vertical;
	}

	.form-group textarea:focus {
		outline: none;
		border-color: #0078d4;
		box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.1);
	}

	.form-group select {
		padding: 8px 12px;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		font-size: 14px;
		background: white;
		cursor: pointer;
	}

	.form-group select:focus {
		outline: none;
		border-color: #0078d4;
	}

	.phases-editor {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.phases-editor-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.phases-editor-header label {
		font-size: 13px;
		font-weight: 600;
		color: #1b1b1b;
	}

	.add-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 6px 12px;
		border: 1px dashed #0078d4;
		border-radius: 4px;
		background: transparent;
		color: #0078d4;
		font-size: 13px;
		cursor: pointer;
		transition: all 0.15s;
	}

	.add-btn:hover {
		background: #e5f1fb;
		border-style: solid;
	}

	.phase-editor {
		border: 1px solid #e0e0e0;
		border-radius: 6px;
		overflow: hidden;
	}

	.phase-editor-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		background: #fafafa;
		border-bottom: 1px solid #e0e0e0;
	}

	.phase-name-input {
		flex: 1;
		padding: 6px 10px;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		font-size: 14px;
		font-weight: 500;
	}

	.phase-name-input:focus {
		outline: none;
		border-color: #0078d4;
	}

	.remove-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 6px;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: #b91c1c;
		cursor: pointer;
		transition: all 0.15s;
	}

	.remove-btn:hover {
		background: #fef2f2;
	}

	.remove-btn.small {
		padding: 4px;
	}

	.tasks-editor {
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.task-editor {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.task-editor input[type="checkbox"] {
		width: 16px;
		height: 16px;
		cursor: pointer;
	}

	.task-input {
		flex: 1;
		padding: 6px 10px;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		font-size: 13px;
	}

	.task-input:focus {
		outline: none;
		border-color: #0078d4;
	}

	.add-task-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 8px;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: #666;
		font-size: 12px;
		cursor: pointer;
		transition: all 0.15s;
		align-self: flex-start;
	}

	.add-task-btn:hover {
		background: #f0f0f0;
		color: #0078d4;
	}

	/* Linked Threads */
	.threads-section {
		margin-top: 24px;
	}

	.threads-section h3 {
		font-size: 14px;
		font-weight: 600;
		color: #1b1b1b;
		margin: 0 0 12px 0;
	}

	.linked-threads {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.linked-thread {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		background: #f5f5f5;
		border-radius: 4px;
		font-size: 13px;
	}

	.thread-provider {
		font-weight: 600;
		text-transform: capitalize;
		color: #0078d4;
	}

	.thread-title {
		flex: 1;
		color: #1b1b1b;
	}

	/* Mobile Responsiveness */
	@media (max-width: 768px) {
		.filters {
			padding: 12px 16px;
		}

		.modal {
			max-width: 100%;
			margin: 16px;
			border-radius: 8px;
		}

		.modal-large {
			max-width: 100%;
		}

		.phase-progress {
			width: 80px;
		}
	}

	@media (max-width: 480px) {
		.page-header {
			padding: 0 12px;
		}

		.plans-list {
			padding: 16px 12px;
		}

		.status-tabs {
			flex-wrap: wrap;
		}

		.phase-header {
			padding: 10px 12px;
		}

		.phase-progress {
			display: none;
		}
	}
</style>
