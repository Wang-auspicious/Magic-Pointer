<script lang="ts">
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import { Spinner } from "$lib/components/ui/spinner";
</script>

<InputGroup.Root class="max-w-3xs">
	<InputGroup.Input
		placeholder="Processing..."
		type='text'
		class="placeholder:text-sm"
		disabled
	/>
	<InputGroup.Addon align="inline-end">
		<Spinner />
	</InputGroup.Addon>
</InputGroup.Root>
