<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';

	let isExpanded = $state(false);
	let toggleExpand = () => {
		isExpanded = !isExpanded;
	};
</script>

<Button variant="ghost" onclick={toggleExpand}>
	{#if isExpanded}
		Show less
	{:else}
		Show more
	{/if}
	{#if isExpanded}
		<ChevronUpIcon class="-me-1" />
	{:else}
		<ChevronDownIcon class="-me-1" />
	{/if}
</Button>
