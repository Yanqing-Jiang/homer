<script lang="ts">
	import type { Toast, ToastType } from '$lib/stores/toasts.svelte';
	import { removeToast } from '$lib/stores/toasts.svelte';

	interface Props {
		toast: Toast;
	}

	let { toast: t }: Props = $props();

	function getIcon(type: ToastType): string {
		switch (type) {
			case 'success':
				return 'M5 13l4 4L19 7';
			case 'error':
				return 'M6 18L18 6M6 6l12 12';
			case 'warning':
				return 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z';
			case 'info':
				return 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z';
		}
	}

	function getColor(type: ToastType): string {
		switch (type) {
			case 'success':
				return '#10b981';
			case 'error':
				return '#ef4444';
			case 'warning':
				return '#f59e0b';
			case 'info':
				return '#3b82f6';
		}
	}
</script>

<div class="toast toast-{t.type}" role="alert" aria-live="polite">
	<div class="toast-icon" style="--toast-color: {getColor(t.type)}">
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
			<path d={getIcon(t.type)} stroke-linecap="round" stroke-linejoin="round" />
		</svg>
	</div>
	<span class="toast-message">{t.message}</span>
	{#if t.dismissible}
		<button class="toast-close" onclick={() => removeToast(t.id)} aria-label="Dismiss">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
				<path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" stroke-linejoin="round" />
			</svg>
		</button>
	{/if}
</div>

<style>
	.toast {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
		background: white;
		border-radius: 6px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		border-left: 4px solid var(--toast-color, #3b82f6);
		min-width: 280px;
		max-width: 400px;
		animation: slideIn 0.3s ease-out;
	}

	@keyframes slideIn {
		from {
			transform: translateX(100%);
			opacity: 0;
		}
		to {
			transform: translateX(0);
			opacity: 1;
		}
	}

	.toast-icon {
		flex-shrink: 0;
		color: var(--toast-color, #3b82f6);
	}

	.toast-message {
		flex: 1;
		font-size: 14px;
		color: #1b1b1b;
		line-height: 1.4;
	}

	.toast-close {
		flex-shrink: 0;
		background: none;
		border: none;
		padding: 4px;
		cursor: pointer;
		color: #9ca3af;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		transition: all 0.15s;
	}

	.toast-close:hover {
		background: #f3f4f6;
		color: #6b7280;
	}

	.toast-success {
		border-left-color: #10b981;
	}

	.toast-error {
		border-left-color: #ef4444;
	}

	.toast-warning {
		border-left-color: #f59e0b;
	}

	.toast-info {
		border-left-color: #3b82f6;
	}
</style>
