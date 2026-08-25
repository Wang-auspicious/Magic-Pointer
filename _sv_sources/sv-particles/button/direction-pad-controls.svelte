<script>
	import { Button } from '$lib/components/ui/button';
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CircleIcon from '@lucide/svelte/icons/circle';
</script>

<div class="inline-grid w-fit grid-cols-3 gap-1">
	<Button aria-label="Pan camera up" class="col-start-2" size="icon" variant="outline">
		<ChevronUpIcon />
	</Button>
	<Button aria-label="Pan camera left" class="col-start-1" size="icon" variant="outline">
		<ChevronLeftIcon />
	</Button>
	<div class="flex items-center justify-center">
		<CircleIcon class="size-4 opacity-80" />
	</div>
	<Button aria-label="Pan camera right" size="icon" variant="outline">
		<ChevronRightIcon />
	</Button>
	<Button aria-label="Pan camera down" class="col-start-2" size="icon" variant="outline">
		<ChevronDownIcon />
	</Button>
</div>
