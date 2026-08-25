<script lang="ts">
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
</script>

<InputGroup.Root class="max-w-3xs">
	<InputGroup.Input placeholder="sv-particles" class="placeholder:text-sm [input]:ps-0!" />
	<InputGroup.Addon>
		<InputGroup.Text>https://</InputGroup.Text>
	</InputGroup.Addon>
	<InputGroup.Addon align="inline-end">
		<InputGroup.Text>.com</InputGroup.Text>
	</InputGroup.Addon>
</InputGroup.Root>
