<script lang="ts">
	import EclipseIcon from '@lucide/svelte/icons/eclipse';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';

	let isVisible = $state(true);
</script>

{#if isVisible}
	<div class="dark w-full bg-muted px-4 py-3 text-foreground md:py-2">
		<div class="flex gap-2 md:items-center">
			<div class="flex grow gap-3 md:items-center md:justify-center">
				<EclipseIcon aria-hidden="true" class="shrink-0 opacity-60 max-md:mt-0.5" size={16} />
				<div class="flex flex-col justify-between gap-3 md:flex-row md:items-center">
					<p class="text-sm">
						It's live and ready to use! Start exploring the latest addition to your toolkit.
					</p>
					<div class="flex gap-2 max-md:flex-wrap">
						<Button class="rounded-full" size="sm">Learn more</Button>
					</div>
				</div>
			</div>
			<Button
				aria-label="Close banner"
				class="group -my-1.5 -me-2 size-8 shrink-0 p-0 hover:bg-transparent"
				onclick={() => (isVisible = false)}
				variant="ghost"
			>
				<XIcon
					aria-hidden="true"
					class="opacity-60 transition-opacity group-hover:opacity-100"
					size={16}
				/>
			</Button>
		</div>
	</div>
{/if}
