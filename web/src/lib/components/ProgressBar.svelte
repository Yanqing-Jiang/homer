<script lang="ts">
	interface Props {
		value: number;
		max?: number;
		size?: 'sm' | 'md' | 'lg';
		showLabel?: boolean;
		color?: 'blue' | 'green' | 'purple';
	}

	let { value, max = 100, size = 'md', showLabel = false, color = 'blue' }: Props = $props();

	const percentage = $derived(Math.min(100, Math.max(0, (value / max) * 100)));
</script>

<div class="progress-container {size}">
	<div class="progress-bar">
		<div
			class="progress-fill {color}"
			style="width: {percentage}%"
		></div>
	</div>
	{#if showLabel}
		<span class="progress-label">{Math.round(percentage)}%</span>
	{/if}
</div>

<style>
	.progress-container {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.progress-bar {
		flex: 1;
		background: #e5e7eb;
		border-radius: 4px;
		overflow: hidden;
	}

	.sm .progress-bar {
		height: 4px;
	}

	.md .progress-bar {
		height: 8px;
	}

	.lg .progress-bar {
		height: 12px;
	}

	.progress-fill {
		height: 100%;
		border-radius: 4px;
		transition: width 0.3s ease;
	}

	.progress-fill.blue {
		background: #0078d4;
	}

	.progress-fill.green {
		background: #10b981;
	}

	.progress-fill.purple {
		background: #8b5cf6;
	}

	.progress-label {
		font-size: 12px;
		color: #666;
		min-width: 36px;
		text-align: right;
	}
</style>
