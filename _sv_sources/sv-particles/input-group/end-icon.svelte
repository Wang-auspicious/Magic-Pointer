<script lang="ts">
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import MailIcon from "@lucide/svelte/icons/mail";
</script>

<InputGroup.Root class="max-w-3xs">
	<InputGroup.Input placeholder="Email" type="email" />
	<InputGroup.Addon align="inline-end">
		<MailIcon />
	</InputGroup.Addon>
</InputGroup.Root>
