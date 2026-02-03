<script lang="ts">
	import { onMount } from 'svelte';
	import { StatusBadge, EmptyState, AuthOverlay } from '$lib/components';
	import JobCalendar from '$lib/components/JobCalendar.svelte';
	import { useAuth } from '$lib/hooks/useAuth.svelte';
	import {
		listScheduledJobs,
		getScheduledJob,
		updateScheduledJob,
		triggerScheduledJob,
		getJobCalendar,
		type ScheduledJob,
		type ScheduledJobDetail,
		type CalendarEvent
	} from '$lib/api/client';
	import { toast } from '$lib/stores/toasts.svelte';

	// State
	let jobs = $state<ScheduledJob[]>([]);
	let selectedJob = $state<ScheduledJobDetail | null>(null);
	let calendarEvents = $state<CalendarEvent[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	const auth = useAuth();

	// Filter state
	let filterStatus = $state<'all' | 'enabled' | 'disabled'>('all');
	let viewMode = $state<'list' | 'calendar'>('list');

	// Calendar state
	let currentMonth = $state(new Date());

	// Fetch jobs on mount
	onMount(async () => {
		await loadJobs();
	});

	async function loadJobs() {
		try {
			loading = true;
			error = null;
			const response = await listScheduledJobs();
			jobs = response.jobs;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load jobs';
		} finally {
			loading = false;
		}
	}

	async function loadCalendar() {
		const year = currentMonth.getFullYear();
		const month = currentMonth.getMonth();
		const start = new Date(year, month, 1).toISOString().split('T')[0];
		const end = new Date(year, month + 1, 0).toISOString().split('T')[0];

		try {
			const response = await getJobCalendar({ start, end });
			calendarEvents = response.events;
		} catch (e) {
			console.error('Failed to load calendar:', e);
		}
	}

	// Load calendar when switching to calendar view or changing month
	$effect(() => {
		if (viewMode === 'calendar') {
			loadCalendar();
		}
	});

	const filteredJobs = $derived(() => {
		if (filterStatus === 'all') return jobs;
		return jobs.filter((j) => (filterStatus === 'enabled' ? j.enabled : !j.enabled));
	});

	const statusCounts = $derived(() => {
		const counts: Record<string, number> = { all: jobs.length };
		jobs.forEach((job) => {
			const status = job.enabled ? 'enabled' : 'disabled';
			counts[status] = (counts[status] || 0) + 1;
		});
		return counts;
	});

	async function openJob(job: ScheduledJob) {
		try {
			const detail = await getScheduledJob(job.id);
			selectedJob = detail;
		} catch (e) {
			console.error('Failed to load job details:', e);
		}
	}

	function closeJob() {
		selectedJob = null;
	}

	async function toggleJobStatus(job: ScheduledJob | ScheduledJobDetail) {
		try {
			const response = await updateScheduledJob(job.id, { enabled: !job.enabled });

			// Update local state
			const index = jobs.findIndex((j) => j.id === job.id);
			if (index !== -1) {
				jobs[index] = { ...jobs[index], enabled: response.enabled };
			}

			// Update selected job if open
			if (selectedJob?.id === job.id) {
				selectedJob = { ...selectedJob, enabled: response.enabled };
			}
		} catch (e) {
			console.error('Failed to toggle job:', e);
			toast.error(`Failed to ${job.enabled ? 'disable' : 'enable'} job: ${e instanceof Error ? e.message : 'Unknown error'}`);
		}
	}

	async function triggerJob(job: ScheduledJob | ScheduledJobDetail) {
		try {
			const response = await triggerScheduledJob(job.id);
			if (response.success) {
				toast.success(`Job "${response.jobName}" triggered successfully!`);
			}
		} catch (e) {
			console.error('Failed to trigger job:', e);
			toast.error(`Failed to trigger job: ${e instanceof Error ? e.message : 'Unknown error'}`);
		}
	}

	function getLaneIcon(lane: string) {
		switch (lane) {
			case 'work':
				return { emoji: '', color: '#3b82f6' };
			case 'invest':
				return { emoji: '', color: '#22c55e' };
			case 'personal':
				return { emoji: '', color: '#a855f7' };
			case 'learning':
				return { emoji: '', color: '#f59e0b' };
			default:
				return { emoji: '', color: '#6b7280' };
		}
	}

	function formatDuration(ms: number | null | undefined): string {
		if (ms == null) return '-';
		if (ms < 1000) return `${ms}ms`;
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) return `${seconds}s`;
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}m ${secs}s`;
	}

	function formatTimeAgo(dateStr: string | null): string {
		if (!dateStr) return 'Never';
		const date = new Date(dateStr);
		const now = Date.now();
		const diff = now - date.getTime();
		const seconds = Math.floor(diff / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);

		if (days > 0) return `${days}d ago`;
		if (hours > 0) return `${hours}h ago`;
		if (minutes > 0) return `${minutes}m ago`;
		return 'Just now';
	}

	function formatNextRun(nextRuns: string[]): string {
		if (nextRuns.length === 0) return 'Not scheduled';
		const date = new Date(nextRuns[0]);
		return date.toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}
</script>

<svelte:head>
	<title>Jobs | Homer</title>
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
<div class="jobs-page">
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
				<h1>Jobs</h1>
				<span class="count">{jobs.length}</span>
			</div>
			<div class="header-right">
				<div class="view-toggle">
					<button
						class="toggle-option"
						class:active={viewMode === 'list'}
						onclick={() => (viewMode = 'list')}
					>
						<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
							<path d="M3 4h18v2H3zm0 7h18v2H3zm0 7h18v2H3z" />
						</svg>
					</button>
					<button
						class="toggle-option"
						class:active={viewMode === 'calendar'}
						onclick={() => (viewMode = 'calendar')}
					>
						<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
							<path
								d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11zM9 11H7v2h2zm4 0h-2v2h2zm4 0h-2v2h2zm-8 4H7v2h2zm4 0h-2v2h2zm4 0h-2v2h2z"
							/>
						</svg>
					</button>
				</div>
				<button class="refresh-btn" onclick={loadJobs} disabled={loading}>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						width="18"
						height="18"
						class:spinning={loading}
					>
						<path d="M23 4v6h-6M1 20v-6h6" />
						<path
							d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"
						/>
					</svg>
				</button>
			</div>
		</div>
	</header>

	{#if viewMode === 'list'}
		<!-- Filters -->
		<div class="filters">
			<div class="status-tabs">
				<button
					class="tab"
					class:active={filterStatus === 'all'}
					onclick={() => (filterStatus = 'all')}
				>
					All <span class="tab-count">{statusCounts().all}</span>
				</button>
				<button
					class="tab"
					class:active={filterStatus === 'enabled'}
					onclick={() => (filterStatus = 'enabled')}
				>
					Enabled <span class="tab-count">{statusCounts().enabled || 0}</span>
				</button>
				<button
					class="tab"
					class:active={filterStatus === 'disabled'}
					onclick={() => (filterStatus = 'disabled')}
				>
					Disabled <span class="tab-count">{statusCounts().disabled || 0}</span>
				</button>
			</div>
		</div>

		<!-- Jobs List -->
		<div class="jobs-list">
			{#if loading}
				<div class="loading-state">
					<div class="spinner"></div>
					<p>Loading jobs...</p>
				</div>
			{:else if error}
				<div class="error-state">
					<p>{error}</p>
					<button onclick={loadJobs}>Retry</button>
				</div>
			{:else if filteredJobs().length === 0}
				<EmptyState
					icon="jobs"
					title="No jobs found"
					description="Scheduled jobs will appear here"
				/>
			{:else}
				{#each filteredJobs() as job}
					{@const laneStyle = getLaneIcon(job.lane)}
					<div class="job-card" style="--lane-color: {laneStyle.color}">
						<button class="job-content" onclick={() => openJob(job)}>
							<div class="job-header">
								<span class="job-lane" title={job.lane}>{job.lane}</span>
								<h3 class="job-name">{job.name}</h3>
								<StatusBadge status={job.enabled ? 'enabled' : 'disabled'} />
							</div>

							<p class="job-schedule">
								<svg
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									width="14"
									height="14"
								>
									<circle cx="12" cy="12" r="10" />
									<path d="M12 6v6l4 2" />
								</svg>
								{job.cronHuman}
								<code class="cron-code">{job.cron}</code>
							</p>

							<div class="job-footer">
								<span class="job-meta">
									Last: {formatTimeAgo(job.lastRun)}
								</span>
								<span class="job-meta">
									Next: {formatNextRun(job.nextRuns)}
								</span>
								{#if job.consecutiveFailures > 0}
									<span class="failure-badge">{job.consecutiveFailures} fails</span>
								{/if}
							</div>
						</button>

						<div class="job-actions">
							<button
								class="toggle-btn"
								class:enabled={job.enabled}
								class:disabled={!job.enabled}
								onclick={() => toggleJobStatus(job)}
								title={job.enabled ? 'Disable' : 'Enable'}
							>
								{#if job.enabled}
									<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
										<path
											d="M17 7H7a5 5 0 000 10h10a5 5 0 000-10zm0 8a3 3 0 110-6 3 3 0 010 6z"
										/>
									</svg>
								{:else}
									<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
										<path
											d="M17 7H7a5 5 0 000 10h10a5 5 0 000-10zM7 15a3 3 0 110-6 3 3 0 010 6z"
										/>
									</svg>
								{/if}
							</button>
							<button class="run-btn" onclick={() => triggerJob(job)} title="Run Now">
								<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
									<path d="M8 5v14l11-7z" />
								</svg>
							</button>
						</div>
					</div>
				{/each}
			{/if}
		</div>
	{:else}
		<!-- Calendar View with FullCalendar -->
		<div class="calendar-view">
			<JobCalendar
				events={calendarEvents}
				{jobs}
				onMonthChange={(date) => {
					currentMonth = date;
					loadCalendar();
				}}
				onEventClick={(jobId) => {
					const job = jobs.find((j) => j.id === jobId);
					if (job) openJob(job);
				}}
			/>
		</div>
	{/if}
</div>

<!-- Job Detail Modal -->
{#if selectedJob}
	<div class="modal-overlay" onclick={closeJob}>
		<div class="modal modal-large" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<div class="modal-title-row">
					<span class="modal-lane" style="--lane-color: {getLaneIcon(selectedJob.lane).color}">
						{selectedJob.lane}
					</span>
					<div>
						<h2>{selectedJob.name}</h2>
						<p class="modal-subtitle">{selectedJob.cronHuman}</p>
					</div>
				</div>
				<div class="modal-header-right">
					<StatusBadge status={selectedJob.enabled ? 'enabled' : 'disabled'} size="md" />
					<button class="modal-close" onclick={closeJob}>
						<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
							<path
								d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
							/>
						</svg>
					</button>
				</div>
			</div>

			<div class="modal-body">
				<div class="job-details">
					<div class="detail-row">
						<span class="detail-label">ID</span>
						<code class="detail-code">{selectedJob.id}</code>
					</div>
					<div class="detail-row">
						<span class="detail-label">Lane</span>
						<span class="detail-value">{selectedJob.lane}</span>
					</div>
					<div class="detail-row">
						<span class="detail-label">Schedule (Cron)</span>
						<code class="detail-code">{selectedJob.cron}</code>
					</div>
					{#if selectedJob.model}
						<div class="detail-row">
							<span class="detail-label">Model</span>
							<span class="detail-value">{selectedJob.model}</span>
						</div>
					{/if}
					{#if selectedJob.timeout}
						<div class="detail-row">
							<span class="detail-label">Timeout</span>
							<span class="detail-value">{selectedJob.timeout}ms</span>
						</div>
					{/if}
					<div class="detail-row">
						<span class="detail-label">Last Run</span>
						<span class="detail-value">{formatTimeAgo(selectedJob.lastRun)}</span>
					</div>
					<div class="detail-row">
						<span class="detail-label">Last Success</span>
						<span class="detail-value">{formatTimeAgo(selectedJob.lastSuccess)}</span>
					</div>
					{#if selectedJob.consecutiveFailures > 0}
						<div class="detail-row">
							<span class="detail-label">Consecutive Failures</span>
							<span class="detail-value failure">{selectedJob.consecutiveFailures}</span>
						</div>
					{/if}
				</div>

				{#if selectedJob.nextRuns.length > 0}
					<div class="next-runs-section">
						<h3>Next Scheduled Runs</h3>
						<div class="next-runs-list">
							{#each selectedJob.nextRuns.slice(0, 5) as run}
								<span class="next-run">
									{new Date(run).toLocaleString('en-US', {
										weekday: 'short',
										month: 'short',
										day: 'numeric',
										hour: 'numeric',
										minute: '2-digit'
									})}
								</span>
							{/each}
						</div>
					</div>
				{/if}

				{#if selectedJob.history && selectedJob.history.length > 0}
					<div class="history-section">
						<h3>Run History</h3>
						<div class="history-table">
							<div class="history-header">
								<span>Time</span>
								<span>Status</span>
								<span>Duration</span>
							</div>
							{#each selectedJob.history as run}
								<div class="history-row">
									<span>
										{new Date(run.startedAt).toLocaleString('en-US', {
											month: 'short',
											day: 'numeric',
											hour: 'numeric',
											minute: '2-digit'
										})}
									</span>
									<StatusBadge status={run.success ? 'success' : 'failed'} />
									<span>{formatDuration(run.durationMs)}</span>
								</div>
								{#if run.error}
									<div class="history-error">
										<code>{run.error}</code>
									</div>
								{/if}
							{/each}
						</div>
					</div>
				{:else}
					<div class="no-history">
						<p>No run history yet</p>
					</div>
				{/if}
			</div>

			<div class="modal-footer">
				<button class="secondary-btn" onclick={closeJob}>Close</button>
				<button class="secondary-btn" onclick={() => selectedJob && toggleJobStatus(selectedJob)}>
					{selectedJob.enabled ? 'Disable' : 'Enable'}
				</button>
				<button class="primary-btn" onclick={() => selectedJob && triggerJob(selectedJob)}>
					<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
						<path d="M8 5v14l11-7z" />
					</svg>
					Run Now
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

	.jobs-page {
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

	.header-right {
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

	.view-toggle {
		display: flex;
		background: rgba(255, 255, 255, 0.1);
		border-radius: 4px;
		overflow: hidden;
	}

	.toggle-option {
		background: none;
		border: none;
		padding: 8px 12px;
		color: #888;
		cursor: pointer;
		display: flex;
		align-items: center;
		transition: all 0.15s;
	}

	.toggle-option.active {
		background: rgba(255, 255, 255, 0.2);
		color: white;
	}

	.toggle-option:hover:not(.active) {
		color: #ccc;
	}

	.refresh-btn {
		background: none;
		border: none;
		padding: 8px;
		color: #888;
		cursor: pointer;
		display: flex;
		align-items: center;
		border-radius: 4px;
		transition: all 0.15s;
	}

	.refresh-btn:hover {
		color: white;
		background: rgba(255, 255, 255, 0.1);
	}

	.refresh-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.spinning {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
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

	/* Jobs List */
	.jobs-list {
		max-width: 1200px;
		margin: 0 auto;
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.loading-state,
	.error-state {
		text-align: center;
		padding: 48px;
		color: #666;
	}

	.spinner {
		width: 32px;
		height: 32px;
		border: 3px solid #e0e0e0;
		border-top-color: #0078d4;
		border-radius: 50%;
		animation: spin 1s linear infinite;
		margin: 0 auto 16px;
	}

	.error-state button {
		margin-top: 16px;
		padding: 8px 16px;
		background: #0078d4;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.job-card {
		background: white;
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		display: flex;
		transition: all 0.15s;
		border-left: 3px solid var(--lane-color, #6b7280);
	}

	.job-card:hover {
		border-color: #0078d4;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
	}

	.job-content {
		flex: 1;
		padding: 16px;
		text-align: left;
		background: none;
		border: none;
		cursor: pointer;
	}

	.job-header {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 8px;
	}

	.job-lane {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		color: var(--lane-color, #6b7280);
		background: rgba(0, 0, 0, 0.05);
		padding: 2px 8px;
		border-radius: 3px;
	}

	.job-name {
		flex: 1;
		font-size: 15px;
		font-weight: 600;
		color: #1b1b1b;
		margin: 0;
	}

	.job-schedule {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: #0078d4;
		margin: 0 0 8px 0;
	}

	.cron-code {
		font-family: monospace;
		background: #f5f5f5;
		padding: 2px 6px;
		border-radius: 3px;
		font-size: 11px;
		color: #666;
	}

	.job-footer {
		display: flex;
		gap: 16px;
		font-size: 12px;
		color: #888;
	}

	.failure-badge {
		background: #fef2f2;
		color: #dc2626;
		padding: 2px 8px;
		border-radius: 3px;
		font-weight: 500;
	}

	.job-actions {
		display: flex;
		flex-direction: column;
		border-left: 1px solid #e0e0e0;
	}

	.toggle-btn,
	.run-btn {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 12px 16px;
		background: none;
		border: none;
		cursor: pointer;
		transition: all 0.15s;
	}

	.toggle-btn {
		border-bottom: 1px solid #e0e0e0;
	}

	.toggle-btn.enabled {
		color: #10b981;
	}

	.toggle-btn.disabled {
		color: #9ca3af;
	}

	.toggle-btn:hover {
		background: #f5f5f5;
	}

	.run-btn {
		color: #0078d4;
	}

	.run-btn:hover {
		background: #e5f1fb;
	}

	/* Calendar View */
	.calendar-view {
		max-width: 1200px;
		margin: 0 auto;
		padding: 24px;
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
		max-width: 600px;
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

	.modal-lane {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		color: var(--lane-color, #6b7280);
		background: rgba(0, 0, 0, 0.05);
		padding: 4px 10px;
		border-radius: 3px;
		margin-top: 2px;
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
		padding: 20px;
		overflow-y: auto;
		flex: 1;
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

	/* Job Details */
	.job-details {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-bottom: 24px;
	}

	.detail-row {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		padding: 8px 0;
		border-bottom: 1px solid #f0f0f0;
	}

	.detail-label {
		font-size: 13px;
		color: #666;
	}

	.detail-value {
		font-size: 14px;
		color: #1b1b1b;
		text-align: right;
	}

	.detail-value.failure {
		color: #dc2626;
		font-weight: 600;
	}

	.detail-code {
		font-family: monospace;
		background: #f5f5f5;
		padding: 2px 6px;
		border-radius: 3px;
		font-size: 13px;
	}

	/* Next Runs */
	.next-runs-section {
		margin-bottom: 24px;
	}

	.next-runs-section h3 {
		font-size: 14px;
		font-weight: 600;
		color: #1b1b1b;
		margin: 0 0 12px 0;
	}

	.next-runs-list {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.next-run {
		background: #f5f5f5;
		padding: 6px 12px;
		border-radius: 4px;
		font-size: 12px;
		color: #666;
	}

	/* History */
	.history-section h3 {
		font-size: 14px;
		font-weight: 600;
		color: #1b1b1b;
		margin: 0 0 12px 0;
	}

	.history-table {
		border: 1px solid #e0e0e0;
		border-radius: 4px;
		overflow: hidden;
	}

	.history-header {
		display: grid;
		grid-template-columns: 1fr 100px 80px;
		gap: 12px;
		padding: 10px 12px;
		background: #f5f5f5;
		font-size: 12px;
		font-weight: 600;
		color: #666;
		text-transform: uppercase;
	}

	.history-row {
		display: grid;
		grid-template-columns: 1fr 100px 80px;
		gap: 12px;
		padding: 10px 12px;
		border-top: 1px solid #e0e0e0;
		font-size: 13px;
		align-items: center;
	}

	.history-error {
		padding: 8px 12px;
		background: #fef2f2;
		border-top: 1px solid #e0e0e0;
	}

	.history-error code {
		font-size: 12px;
		color: #dc2626;
		word-break: break-all;
	}

	.no-history {
		text-align: center;
		padding: 24px;
		color: #888;
		font-size: 14px;
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

	}

	@media (max-width: 480px) {
		.page-header {
			padding: 0 12px;
		}

		.jobs-list {
			padding: 16px 12px;
		}

		.status-tabs {
			flex-wrap: wrap;
		}

		.job-footer {
			flex-direction: column;
			gap: 4px;
		}

		.history-table {
			font-size: 12px;
		}

		.history-header,
		.history-row {
			grid-template-columns: 1fr 80px 60px;
			gap: 8px;
		}
	}
</style>
