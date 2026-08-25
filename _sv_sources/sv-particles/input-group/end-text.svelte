<script lang="ts">
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
</script>

<InputGroup.Root class='max-w-xs'>
	<InputGroup.Input placeholder="Choose a username" class='placeholder:text-sm'/>
	<InputGroup.Addon align="inline-end">
		<InputGroup.Text>@animations.com</InputGroup.Text>
	</InputGroup.Addon>
</InputGroup.Root>
