<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';

	import type { StepEvent } from '$lib/api/client';

	type ActivityStep = StepEvent & { startedAt: number; completed: boolean };

	let {
		steps = [],
		isRunning = false,
		storageKey = 'default'
	}: {
		steps?: ActivityStep[];
		isRunning?: boolean;
		storageKey?: string;
	} = $props();

	let collapsed = $state(false);
	let hydrated = false;
	let previousRunning = false;

	const persistedKey = $derived(`homer:run-activity:${storageKey}`);
	const actionCount = $derived(steps.filter((step) => step.type !== 'thinking').length);
	const thinkingCount = $derived(steps.filter((step) => step.type === 'thinking').length);
	const lastStep = $derived(steps.at(-1) ?? null);
	const summaryState = $derived(
		isRunning ? (lastStep?.type === 'thinking' ? 'Thinking' : 'Running') : 'Completed'
	);
	const summaryMeta = $derived.by(() => {
		const parts = [`${steps.length} step${steps.length === 1 ? '' : 's'}`];
		if (actionCount > 0) {
			parts.push(`${actionCount} action${actionCount === 1 ? '' : 's'}`);
		}
		if (thinkingCount > 0) {
			parts.push(`${thinkingCount} thought${thinkingCount === 1 ? '' : 's'}`);
		}
		return parts.join(' • ');
	});

	function activityLabel(step: ActivityStep): string {
		if (step.type === 'thinking') {
			return step.labelDone || step.label;
		}
		return step.completed ? step.labelDone : step.label;
	}

	function activityIcon(step: ActivityStep): 'spark' | 'done' | 'spinner' {
		if (step.type === 'thinking') return 'spark';
		return step.completed ? 'done' : 'spinner';
	}

	function persistCollapsed() {
		if (!browser || !hydrated || !storageKey) return;
		localStorage.setItem(persistedKey, collapsed ? 'true' : 'false');
	}

	function toggleCollapsed() {
		collapsed = !collapsed;
		persistCollapsed();
	}

	onMount(() => {
		if (browser && storageKey) {
			const saved = localStorage.getItem(persistedKey);
			if (saved !== null) {
				collapsed = saved === 'true';
			} else {
				collapsed = !isRunning;
			}
		} else {
			collapsed = !isRunning;
		}

		hydrated = true;
		previousRunning = isRunning;
	});

	$effect(() => {
		if (!hydrated) return;

		if (isRunning && !previousRunning) {
			collapsed = false;
			persistCollapsed();
		} else if (!isRunning && previousRunning && steps.length > 0) {
			collapsed = true;
			persistCollapsed();
		}

		previousRunning = isRunning;
	});
</script>

{#if steps.length > 0}
	<div class="activity-panel">
		<button
			type="button"
			class="activity-summary"
			aria-expanded={!collapsed}
			onclick={toggleCollapsed}
		>
			<div class="activity-summary-main">
				<span class="activity-chevron" class:collapsed>{collapsed ? '▸' : '▾'}</span>
				<div class="activity-summary-text">
					<div class="activity-summary-title">Run activity</div>
					<div class="activity-summary-meta">{summaryState} • {summaryMeta}</div>
				</div>
			</div>
			{#if lastStep}
				<div class="activity-summary-last">{activityLabel(lastStep)}</div>
			{/if}
		</button>

		{#if !collapsed}
			<div class="activity-list">
				{#each steps as step (step.id ?? `${step.type}:${step.label}:${step.startedAt}`)}
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
		{/if}
	</div>
{/if}

<style>
	.activity-panel {
		border: 1px solid #d8d4d0;
		border-radius: 10px;
		background: #f8f7f5;
		margin-bottom: 12px;
		overflow: hidden;
	}

	.activity-summary {
		width: 100%;
		background: transparent;
		border: none;
		padding: 12px 14px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		cursor: pointer;
		text-align: left;
	}

	.activity-summary:hover {
		background: rgba(0, 120, 212, 0.04);
	}

	.activity-summary-main {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.activity-chevron {
		font-size: 13px;
		color: #605e5c;
		flex-shrink: 0;
	}

	.activity-summary-text {
		min-width: 0;
	}

	.activity-summary-title {
		font-size: 13px;
		font-weight: 600;
		color: #1b1b1b;
	}

	.activity-summary-meta {
		font-size: 12px;
		color: #605e5c;
	}

	.activity-summary-last {
		max-width: 320px;
		font-size: 12px;
		color: #605e5c;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.activity-list {
		border-top: 1px solid #e5e1dc;
		padding: 10px 12px 12px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.activity-item {
		display: flex;
		gap: 10px;
		align-items: flex-start;
	}

	.activity-icon {
		width: 20px;
		height: 20px;
		border-radius: 999px;
		background: white;
		border: 1px solid #d8d4d0;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #605e5c;
		flex-shrink: 0;
	}

	.activity-item.completed .activity-icon {
		color: #107c10;
		border-color: #b5d8b5;
	}

	.activity-item.thinking .activity-icon {
		color: #0078d4;
		border-color: #b9d6f2;
	}

	.activity-body {
		min-width: 0;
	}

	.activity-label {
		font-size: 13px;
		font-weight: 500;
		color: #1b1b1b;
	}

	.activity-preview {
		margin-top: 3px;
		font-size: 12px;
		color: #605e5c;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.activity-spinner {
		width: 10px;
		height: 10px;
		border-radius: 999px;
		border: 2px solid rgba(0, 120, 212, 0.2);
		border-top-color: #0078d4;
		animation: spin 1s linear infinite;
	}

	.activity-check {
		color: currentColor;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 720px) {
		.activity-summary {
			flex-direction: column;
			align-items: stretch;
		}

		.activity-summary-last {
			max-width: none;
		}
	}
</style>
