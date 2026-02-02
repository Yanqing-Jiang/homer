<script lang="ts">
	import { getToasts } from '$lib/stores/toasts.svelte';
	import Toast from './Toast.svelte';

	// Get reactive toasts
	const toasts = $derived(getToasts());
</script>

{#if toasts.length > 0}
	<div class="toast-container" role="region" aria-label="Notifications">
		{#each toasts as t (t.id)}
			<Toast toast={t} />
		{/each}
	</div>
{/if}

<style>
	.toast-container {
		position: fixed;
		top: 16px;
		right: 16px;
		z-index: 9999;
		display: flex;
		flex-direction: column;
		gap: 8px;
		pointer-events: none;
	}

	.toast-container :global(.toast) {
		pointer-events: auto;
	}

	@media (max-width: 480px) {
		.toast-container {
			top: 8px;
			right: 8px;
			left: 8px;
		}

		.toast-container :global(.toast) {
			max-width: none;
			min-width: auto;
		}
	}
</style>
