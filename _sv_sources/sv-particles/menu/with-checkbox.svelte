<script lang="ts">
	import { Button } from "$lib/components/ui/button";
	import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
	let notify = $state({
		autosave: true,
		notification: false,
	});
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline">Open Menu</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content>
		<DropdownMenu.CheckboxItem bind:checked={notify.autosave}
			>Auto Save</DropdownMenu.CheckboxItem
		>
		<DropdownMenu.CheckboxItem bind:checked={notify.notification}
			>Notification</DropdownMenu.CheckboxItem
		>
	</DropdownMenu.Content>
</DropdownMenu.Root>
