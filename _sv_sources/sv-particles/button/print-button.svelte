<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import PrinterIcon from '@lucide/svelte/icons/printer';
	import { Kbd, KbdGroup } from '$lib/components/ui/kbd/index.js';
</script>

<Button variant="outline">
	<PrinterIcon aria-hidden="true" />
	Print
	<KbdGroup class="-me-1">
		<Kbd>&#8984;</Kbd>
		<Kbd>P</Kbd>
	</KbdGroup>
</Button>
