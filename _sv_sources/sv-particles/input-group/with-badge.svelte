<script lang="ts">
	import { Badge } from "$lib/components/ui/badge";
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
</script>

<InputGroup.Root class='max-w-xs'>
	<InputGroup.Input placeholder="Type of search..." />
	<InputGroup.Addon align="inline-end">
		<Badge variant="secondary">Badge</Badge>
	</InputGroup.Addon>
</InputGroup.Root>
