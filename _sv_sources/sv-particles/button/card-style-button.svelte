<script lang="ts">
	import { Button } from '$lib/components/ui/button';
    import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
</script>

<Button class="h-auto! gap-4 px-4 py-3 text-left" variant="outline">
	<div class="flex flex-col gap-0.5">
		<h3>Talent Agency</h3>
		<p class="font-normal whitespace-break-spaces text-muted-foreground">Matches for your roster</p>
	</div>
	<ChevronRightIcon

		class="transition-transform in-[[data-slot=button]:hover]:translate-x-0.5"
	/>
</Button>
