<script lang="ts">
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';

	let isVisible = $state(true);
</script>

{#if isVisible}
	<div class="dark w-full bg-muted px-4 py-3 text-foreground">
		<div class="flex gap-2 md:items-center">
			<div class="flex grow gap-3 md:items-center">
				<div
					aria-hidden="true"
					class="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 max-md:mt-0.5"
				>
					<RocketIcon class="opacity-80" size={16} />
				</div>
				<div class="flex grow flex-col justify-between gap-3 md:flex-row md:items-center">
					<div class="space-y-0.5">
						<p class="text-sm font-medium">Boost your experience with coss.com</p>
						<p class="text-sm text-muted-foreground">
							The new feature is live! Try it out and let us know what you think.
						</p>
					</div>
					<div class="flex gap-2 max-md:flex-wrap">
						<Button class="text-sm" size="sm">Try now</Button>
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
