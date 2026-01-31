<script lang="ts">
	interface Props {
		checked: boolean;
		label: string;
		disabled?: boolean;
		onToggle?: (checked: boolean) => void;
	}

	let { checked, label, disabled = false, onToggle }: Props = $props();

	function handleChange(e: Event) {
		const target = e.target as HTMLInputElement;
		if (onToggle) {
			onToggle(target.checked);
		}
	}
</script>

<label class="task-checkbox" class:disabled class:checked>
	<input
		type="checkbox"
		{checked}
		{disabled}
		onchange={handleChange}
	/>
	<span class="checkmark">
		{#if checked}
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
				<path d="M5 13l4 4L19 7" />
			</svg>
		{/if}
	</span>
	<span class="label">{label}</span>
</label>

<style>
	.task-checkbox {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		cursor: pointer;
		padding: 6px 0;
	}

	.task-checkbox.disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}

	.checkmark {
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

	.checkmark svg {
		width: 12px;
		height: 12px;
		color: white;
	}

	.task-checkbox:hover:not(.disabled) .checkmark {
		border-color: #0078d4;
	}

	.task-checkbox.checked .checkmark {
		background: #0078d4;
		border-color: #0078d4;
	}

	.label {
		font-size: 14px;
		color: #1b1b1b;
		line-height: 1.4;
	}

	.task-checkbox.checked .label {
		color: #666;
		text-decoration: line-through;
	}
</style>
