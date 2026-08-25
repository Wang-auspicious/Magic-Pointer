<script lang="ts">
	import { Button } from "$lib/components/ui/button";
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
</script>

<InputGroup.Root class="max-w-xs">
	<InputGroup.Input placeholder="Search..." />
	<InputGroup.Addon align="inline-end">
		<Button size="xs" variant='secondary'>Search</Button>
	</InputGroup.Addon>
</InputGroup.Root>
