<script>
	import { Button } from "$lib/components/ui/button";
</script>

<div class="z-50 w-full rounded-md border bg-background px-4 py-3 shadow-lg">
	<div class="flex flex-col justify-between gap-3 md:flex-row md:items-center">
		<p class="text-sm">
			We use cookies to improve your experience, analyze site usage, and show personalized
			content.
		</p>
		<div class="flex gap-2 max-md:flex-wrap">
			<Button size="sm">Accept</Button>
			<Button size="sm" variant="outline">Decline</Button>
		</div>
	</div>
</div>
