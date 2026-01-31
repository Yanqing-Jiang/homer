<script lang="ts">
	interface Props {
		tags: string[];
		size?: 'sm' | 'md';
		clickable?: boolean;
		onTagClick?: (tag: string) => void;
	}

	let { tags, size = 'sm', clickable = false, onTagClick }: Props = $props();

	function handleClick(tag: string) {
		if (clickable && onTagClick) {
			onTagClick(tag);
		}
	}
</script>

{#if tags.length > 0}
	<div class="tag-list">
		{#each tags as tag}
			{#if clickable}
				<button class="tag {size === 'md' ? 'tag-md' : ''}" onclick={() => handleClick(tag)}>
					{tag}
				</button>
			{:else}
				<span class="tag {size === 'md' ? 'tag-md' : ''}">{tag}</span>
			{/if}
		{/each}
	</div>
{/if}

<style>
	.tag-list {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.tag {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		background: #f3f4f6;
		border: 1px solid #e5e7eb;
		border-radius: 4px;
		font-size: 11px;
		color: #4b5563;
	}

	.tag-md {
		padding: 4px 10px;
		font-size: 12px;
	}

	button.tag {
		cursor: pointer;
		transition: all 0.15s;
	}

	button.tag:hover {
		background: #e5e7eb;
		border-color: #d1d5db;
	}
</style>
