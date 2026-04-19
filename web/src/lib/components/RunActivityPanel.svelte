<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';

	import type { StepEvent } from '$lib/api/client';

	type ActivityStep = StepEvent & { startedAt: number; completed: boolean };

	let {
		steps = [],
		isRunning = false,
		storageKey = 'default',
		onStop
	}: {
		steps?: ActivityStep[];
		isRunning?: boolean;
		storageKey?: string;
		onStop?: () => void;
	} = $props();

	let stopRequested = $state(false);

	function handleStopClick(event: MouseEvent) {
		event.stopPropagation();
		if (stopRequested || !onStop) return;
		stopRequested = true;
		try {
			onStop();
		} catch (err) {
			console.warn('onStop failed', err);
			stopRequested = false;
		}
	}

	$effect(() => {
		if (!isRunning) stopRequested = false;
	});

	let collapsed = $state(false);
	let hydrated = false;
	let previousRunning = false;

	type ToolCategory = 'file' | 'shell' | 'web' | 'agent' | 'mcp' | 'thinking' | 'other';

	let expandedThinking = $state<Set<string>>(new Set());

	function thinkingKey(step: ActivityStep, index: number): string {
		return step.id ?? `thinking:${index}:${step.startedAt}`;
	}

	function toggleThinking(key: string, event: MouseEvent) {
		event.stopPropagation();
		const next = new Set(expandedThinking);
		if (next.has(key)) next.delete(key); else next.add(key);
		expandedThinking = next;
	}

	function thinkingDurationLabel(step: ActivityStep): string {
		// For replayed thinking events we don't know the actual thinking end time;
		// fall back to "Thought". Live flow uses startedAt only.
		return step.labelDone || 'Thought';
	}

	function toolCategory(step: ActivityStep): ToolCategory {
		if (step.type === 'thinking') return 'thinking';
		const name = step.tool ?? '';
		if (!name) return 'other';
		if (name.startsWith('mcp__')) return 'mcp';
		switch (name) {
			case 'Read':
			case 'Write':
			case 'Edit':
			case 'NotebookEdit':
			case 'Glob':
			case 'Grep':
				return 'file';
			case 'Bash':
			case 'BashOutput':
			case 'KillShell':
				return 'shell';
			case 'WebFetch':
			case 'WebSearch':
				return 'web';
			case 'Agent':
			case 'Task':
				return 'agent';
			default:
				return 'other';
		}
	}

	function toolBadge(step: ActivityStep): string {
		if (step.type === 'thinking') return 'THINK';
		const name = step.tool ?? '';
		if (!name) return '';
		if (name.startsWith('mcp__')) {
			// mcp__<server>__<tool> -> <server>
			const parts = name.split('__');
			return parts[1] ? parts[1].toUpperCase().slice(0, 10) : 'MCP';
		}
		return name.toUpperCase();
	}

	const persistedKey = $derived(`homer:run-activity:${storageKey}`);
	const thinkingCount = $derived(steps.filter((step) => step.type === 'thinking').length);
	const categoryCounts = $derived.by(() => {
		const counts: Record<ToolCategory, number> = { file: 0, shell: 0, web: 0, agent: 0, mcp: 0, thinking: 0, other: 0 };
		for (const step of steps) counts[toolCategory(step)]++;
		return counts;
	});
	const lastStep = $derived(steps.at(-1) ?? null);
	const summaryState = $derived(
		isRunning ? (lastStep?.type === 'thinking' ? 'Thinking' : 'Running') : 'Completed'
	);
	const summaryMeta = $derived.by(() => {
		const parts: string[] = [];
		if (thinkingCount > 0) parts.push(`thought ${thinkingCount}x`);
		if (categoryCounts.file > 0) parts.push(`${categoryCounts.file} file op${categoryCounts.file === 1 ? '' : 's'}`);
		if (categoryCounts.shell > 0) parts.push(`${categoryCounts.shell} shell`);
		if (categoryCounts.web > 0) parts.push(`${categoryCounts.web} web`);
		if (categoryCounts.mcp > 0) parts.push(`${categoryCounts.mcp} mcp`);
		if (categoryCounts.agent > 0) parts.push(`${categoryCounts.agent} agent`);
		if (categoryCounts.other > 0) parts.push(`${categoryCounts.other} other`);
		if (parts.length === 0) parts.push(`${steps.length} step${steps.length === 1 ? '' : 's'}`);
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

{#if steps.length > 0 || isRunning}
	<div class="activity-panel" class:running={isRunning}>
		<div class="activity-header">
			<button
				type="button"
				class="activity-summary"
				aria-expanded={!collapsed}
				onclick={toggleCollapsed}
			>
				<div class="activity-summary-main">
					<span class="activity-chevron" class:collapsed>{collapsed ? '▸' : '▾'}</span>
					<div class="activity-summary-text">
						<div class="activity-summary-title">
							{#if isRunning}
								<span class="running-dot" aria-hidden="true"></span>
							{/if}
							Run activity
						</div>
						<div class="activity-summary-meta">
							{#if steps.length === 0 && isRunning}
								Starting…
							{:else}
								{summaryState} • {summaryMeta}
							{/if}
						</div>
					</div>
				</div>
				{#if lastStep}
					<div class="activity-summary-last">{activityLabel(lastStep)}</div>
				{/if}
			</button>
			{#if isRunning && onStop}
				<button
					type="button"
					class="activity-stop"
					class:pending={stopRequested}
					onclick={handleStopClick}
					disabled={stopRequested}
					aria-label={stopRequested ? 'Stopping run' : 'Stop run'}
					title={stopRequested ? 'Stopping…' : 'Stop run'}
				>
					<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
						<rect x="1" y="1" width="8" height="8" rx="1" fill="currentColor" />
					</svg>
					<span>{stopRequested ? 'Stopping…' : 'Stop'}</span>
				</button>
			{/if}
		</div>

		{#if !collapsed}
			<div class="activity-list">
				{#each steps as step, i (step.id ?? `${step.type}:${step.label}:${step.startedAt}`)}
					{@const cat = toolCategory(step)}
					{@const badge = toolBadge(step)}
					{@const isThinking = step.type === 'thinking'}
					{@const tkey = isThinking ? thinkingKey(step, i) : ''}
					{@const thinkingExpanded = isThinking && expandedThinking.has(tkey)}
					<div
						class="activity-item cat-{cat}"
						class:completed={step.completed}
						class:thinking={isThinking}
					>
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
							{#if isThinking && step.preview}
								<button
									type="button"
									class="thinking-toggle"
									aria-expanded={thinkingExpanded}
									onclick={(e) => toggleThinking(tkey, e)}
								>
									<span class="tool-badge badge-thinking">THINK</span>
									<span class="activity-text">{thinkingDurationLabel(step)}</span>
									<span class="thinking-chevron">{thinkingExpanded ? '▾' : '▸'}</span>
								</button>
								{#if thinkingExpanded}
									<div class="activity-preview cat-preview-thinking thinking-body">{step.preview}</div>
								{/if}
							{:else}
								<div class="activity-label">
									{#if badge}
										<span class="tool-badge badge-{cat}">{badge}</span>
									{/if}
									<span class="activity-text">{activityLabel(step)}</span>
								</div>
								{#if step.preview}
									<div class="activity-preview cat-preview-{cat}">{step.preview}</div>
								{/if}
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

	.activity-panel.running {
		border-color: rgba(0, 120, 212, 0.4);
		box-shadow: 0 0 0 1px rgba(0, 120, 212, 0.08);
	}

	.activity-header {
		display: flex;
		align-items: stretch;
		gap: 0;
	}

	.activity-summary {
		flex: 1;
		background: transparent;
		border: none;
		padding: 12px 14px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		cursor: pointer;
		text-align: left;
		min-width: 0;
	}

	.activity-summary:hover {
		background: rgba(0, 120, 212, 0.04);
	}

	.running-dot {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #0078d4;
		margin-right: 6px;
		vertical-align: middle;
		animation: pulse 1.4s ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; transform: scale(1); }
		50% { opacity: 0.4; transform: scale(0.75); }
	}

	.activity-stop {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin: 10px 12px 10px 0;
		padding: 4px 10px;
		font-size: 12px;
		font-weight: 600;
		color: #d83b01;
		background: rgba(216, 59, 1, 0.08);
		border: 1px solid rgba(216, 59, 1, 0.28);
		border-radius: 4px;
		cursor: pointer;
		transition: background 0.15s, border-color 0.15s, color 0.15s;
	}

	.activity-stop:hover:not(:disabled) {
		background: rgba(216, 59, 1, 0.14);
		border-color: rgba(216, 59, 1, 0.5);
	}

	.activity-stop:active:not(:disabled) {
		background: rgba(216, 59, 1, 0.22);
	}

	.activity-stop:disabled,
	.activity-stop.pending {
		color: #8a8886;
		background: rgba(216, 59, 1, 0.04);
		border-color: rgba(216, 59, 1, 0.14);
		cursor: default;
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
		padding-left: 8px;
		border-left: 3px solid transparent;
	}

	.activity-item.cat-file { border-left-color: #0078d4; }
	.activity-item.cat-shell { border-left-color: #ffb900; }
	.activity-item.cat-web { border-left-color: #008272; }
	.activity-item.cat-mcp { border-left-color: #8764b8; }
	.activity-item.cat-agent { border-left-color: #4f46e5; }
	.activity-item.cat-thinking { border-left-color: #b9d6f2; }
	.activity-item.cat-other { border-left-color: #a19f9d; }

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
		flex: 1;
	}

	.activity-label {
		font-size: 13px;
		font-weight: 500;
		color: #1b1b1b;
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.activity-text {
		min-width: 0;
		word-break: break-word;
	}

	.tool-badge {
		display: inline-block;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.03em;
		padding: 2px 6px;
		border-radius: 4px;
		line-height: 1.2;
		font-family: 'Cascadia Code', 'SF Mono', 'Fira Code', Menlo, monospace;
		flex-shrink: 0;
	}

	.tool-badge.badge-file { background: rgba(0, 120, 212, 0.12); color: #004578; }
	.tool-badge.badge-shell { background: rgba(255, 185, 0, 0.18); color: #8a5a00; }
	.tool-badge.badge-web { background: rgba(0, 130, 114, 0.14); color: #005448; }
	.tool-badge.badge-mcp { background: rgba(135, 100, 184, 0.14); color: #5c3c8a; }
	.tool-badge.badge-agent { background: rgba(79, 70, 229, 0.14); color: #3730a3; }
	.tool-badge.badge-thinking { background: rgba(0, 120, 212, 0.08); color: #0078d4; }
	.tool-badge.badge-other { background: rgba(97, 94, 92, 0.12); color: #3b3a39; }

	.activity-preview {
		margin-top: 4px;
		font-size: 12px;
		color: #605e5c;
		white-space: pre-wrap;
		word-break: break-word;
		padding: 6px 8px;
		border-radius: 4px;
		background: rgba(0, 0, 0, 0.02);
	}

	.activity-preview.cat-preview-shell {
		font-family: 'Cascadia Code', 'SF Mono', 'Fira Code', Menlo, monospace;
		font-size: 11.5px;
		background: #0d1117;
		color: #c9d1d9;
		border: 1px solid #30363d;
	}

	.activity-preview.cat-preview-file,
	.activity-preview.cat-preview-web,
	.activity-preview.cat-preview-mcp,
	.activity-preview.cat-preview-agent {
		background: rgba(245, 247, 250, 0.9);
		border: 1px solid rgba(208, 215, 222, 0.6);
	}

	.thinking-toggle {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 0;
		background: transparent;
		border: none;
		cursor: pointer;
		font: inherit;
		font-size: 13px;
		color: #1b1b1b;
		text-align: left;
	}

	.thinking-toggle:hover {
		color: #0078d4;
	}

	.thinking-chevron {
		color: #605e5c;
		font-size: 11px;
	}

	.thinking-body {
		margin-top: 6px;
		font-style: italic;
		color: #3b3a39;
		background: rgba(0, 120, 212, 0.04);
		border: 1px solid rgba(0, 120, 212, 0.12);
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
