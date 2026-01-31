<script lang="ts">
	type Status = 'draft' | 'review' | 'planning' | 'execution' | 'completed' | 'archived' | 'active' | 'expired' | 'enabled' | 'disabled' | 'pending' | 'in_progress' | 'success' | 'failed';

	interface Props {
		status: Status;
		size?: 'sm' | 'md';
	}

	let { status, size = 'sm' }: Props = $props();

	const statusConfig: Record<Status, { label: string; class: string }> = {
		draft: { label: 'Draft', class: 'badge-gray' },
		review: { label: 'Review', class: 'badge-yellow' },
		planning: { label: 'Planning', class: 'badge-blue' },
		execution: { label: 'Execution', class: 'badge-purple' },
		completed: { label: 'Completed', class: 'badge-green' },
		archived: { label: 'Archived', class: 'badge-gray' },
		active: { label: 'Active', class: 'badge-green' },
		expired: { label: 'Expired', class: 'badge-gray' },
		enabled: { label: 'Enabled', class: 'badge-green' },
		disabled: { label: 'Disabled', class: 'badge-gray' },
		pending: { label: 'Pending', class: 'badge-yellow' },
		in_progress: { label: 'In Progress', class: 'badge-blue' },
		success: { label: 'Success', class: 'badge-green' },
		failed: { label: 'Failed', class: 'badge-red' }
	};

	const config = $derived(statusConfig[status] || { label: status, class: 'badge-gray' });
</script>

<span class="badge {config.class} {size === 'md' ? 'badge-md' : ''}">
	{config.label}
</span>

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border-radius: 12px;
		font-size: 11px;
		font-weight: 500;
		text-transform: capitalize;
	}

	.badge-md {
		padding: 4px 12px;
		font-size: 12px;
	}

	.badge-gray {
		background: #e5e5e5;
		color: #666;
	}

	.badge-yellow {
		background: #fef3c7;
		color: #92400e;
	}

	.badge-blue {
		background: #dbeafe;
		color: #1e40af;
	}

	.badge-purple {
		background: #ede9fe;
		color: #5b21b6;
	}

	.badge-green {
		background: #d1fae5;
		color: #065f46;
	}

	.badge-red {
		background: #fee2e2;
		color: #991b1b;
	}
</style>
