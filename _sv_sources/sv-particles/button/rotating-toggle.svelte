<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import PlusIcon from '@lucide/svelte/icons/plus';

	let open: boolean = $state(false);

	let updateMenu = () => {
		open = !open;
	};
</script>

<Button
	aria-expanded={open}
	aria-label={open ? 'Close menu' : 'Open menu'}
	class="rounded-full before:rounded-full"
	size="icon"
	onclick={updateMenu}
	variant="outline"
>
	<PlusIcon
		class="in-aria-expanded:rotate-135 transition-transform duration-500 ease-[cubic-bezier(0.68,-0.6,0.32,1.6)]"
	/>
</Button>
