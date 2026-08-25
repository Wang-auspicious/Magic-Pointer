<script lang="ts">
	import { Button } from "$lib/components/ui/button";
	import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
	import { Label } from "$lib/components/ui/label";
	import { Switch } from "$lib/components/ui/switch";

	let notify = $state({
		auto_save: true,
		notifications: false,
	});
</script>
<!-- Didn't work well  -->
<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline">Open Menu</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content class="min-w-36">
		<DropdownMenu.Item closeOnSelect={false}>
			<Label for="auto-save">Auto Save</Label>
			<Switch id="auto-save" bind:checked={notify.auto_save} class="ml-auto" />
		</DropdownMenu.Item>
		<DropdownMenu.CheckboxItem closeOnSelect={false} bind:checked={notify.notifications}>
			<Label for="notifications">Notifications</Label>
		</DropdownMenu.CheckboxItem>
	</DropdownMenu.Content>
</DropdownMenu.Root>
