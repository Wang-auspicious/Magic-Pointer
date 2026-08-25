<script lang="ts">
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import EclipseIcon from '@lucide/svelte/icons/eclipse';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';

	let isVisible = $state(true);
</script>

{#if isVisible}
	<div class="dark w-full bg-muted px-4 py-3 text-foreground">
		<div class="flex gap-2">
			<div class="flex grow gap-3">
				<EclipseIcon aria-hidden="true" class="mt-0.5 shrink-0 opacity-60" size={16} />
				<div class="flex grow flex-col justify-between gap-2 md:flex-row">
					<p class="text-sm">
						We just added something awesome to make your experience even better.
					</p>
					<a class="group text-sm font-medium whitespace-nowrap" href="/">
						Learn more
						<ArrowRightIcon
							aria-hidden="true"
							class="ms-1 -mt-0.5 inline-flex opacity-60 transition-transform group-hover:translate-x-0.5"
							size={16}
						/>
					</a>
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
