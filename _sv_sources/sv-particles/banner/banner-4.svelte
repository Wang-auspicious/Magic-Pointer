<script>
	import EclipseIcon from "@lucide/svelte/icons/eclipse";
	import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
</script>

<div class="dark bg-muted px-4 py-3 w-full text-foreground">
	<div class="flex flex-col justify-between gap-2 md:flex-row">
		<div class="flex grow gap-3">
			<EclipseIcon aria-hidden="true" class="mt-0.5 shrink-0 opacity-60" size={16} />
			<div class="flex grow flex-col justify-between gap-2 md:flex-row md:items-center">
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
	</div>
</div>
