<script lang="ts">
	let { executor, model }: { executor: string; model?: string } = $props();
</script>

<span class="executor-badge" class:executor-claude={executor === 'claude'}
	class:executor-gemini={executor === 'gemini'}
	class:executor-codex={executor === 'codex'}
	class:executor-opencode={executor === 'opencode'}
	class:executor-kimi={executor === 'kimi'}
	class:executor-chatgpt={executor === 'chatgpt'}>
	{executor}
	{#if model}
		<span class="executor-model">({model})</span>
	{/if}
</span>

<style>
	.executor-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 3px 10px;
		border-radius: 12px;
		font-size: 11px;
		font-weight: 600;
		text-transform: capitalize;
		white-space: nowrap;
	}

	.executor-badge.executor-claude {
		background: rgba(255, 255, 255, 0.9);
		color: #0078d4;
	}

	.executor-badge.executor-gemini {
		background: #4285f4;
		color: white;
	}

	.executor-badge.executor-codex {
		background: #10b981;
		color: white;
	}

	.executor-badge.executor-opencode {
		background: #8b5cf6;
		color: white;
	}

	.executor-badge.executor-kimi {
		background: #f59e0b;
		color: white;
	}

	.executor-badge.executor-chatgpt {
		background: #74aa9c;
		color: white;
	}

	.executor-model {
		font-weight: 400;
		opacity: 0.8;
	}
</style>
