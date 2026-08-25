<script lang="ts">
	import * as Table from "$lib/components/ui/table/index.js";
	import { CheckIcon, MonitorIcon, SmartphoneIcon, XIcon } from "@lucide/svelte";

	const items = [
		{
			desktop: [
				{ name: "Chrome", supported: true, version: "115" },
				{ name: "Edge", supported: true, version: "115" },
				{ name: "Firefox", supported: false, version: "111" },
				{ name: "Opera", supported: true, version: "101" },
				{ name: "Safari", supported: false, version: "No" },
			],
			feature: "scroll-timeline",
			mobile: [
				{ name: "Chrome Android", supported: true, version: "115" },
				{ name: "Firefox Android", supported: false, version: "No" },
				{ name: "Opera Android", supported: true, version: "77" },
				{ name: "Safari iOS", supported: false, version: "No" },
				{ name: "Samsung Internet", supported: true, version: "23" },
			],
		},
		{
			desktop: [
				{ name: "Chrome", supported: true, version: "115" },
				{ name: "Edge", supported: true, version: "115" },
				{ name: "Firefox", supported: false, version: "114" },
				{ name: "Opera", supported: true, version: "101" },
				{ name: "Safari", supported: false, version: "No" },
			],
			feature: "view-timeline",
			mobile: [
				{ name: "Chrome Android", supported: true, version: "115" },
				{ name: "Firefox Android", supported: false, version: "No" },
				{ name: "Opera Android", supported: true, version: "77" },
				{ name: "Safari iOS", supported: false, version: "No" },
				{ name: "Samsung Internet", supported: true, version: "23" },
			],
		},
		{
			desktop: [
				{ name: "Chrome", supported: true, version: "127" },
				{ name: "Edge", supported: true, version: "127" },
				{ name: "Firefox", supported: false, version: "3" },
				{ name: "Opera", supported: true, version: "113" },
				{ name: "Safari", supported: true, version: "16.4" },
			],
			feature: "font-size-adjust",
			mobile: [
				{ name: "Chrome Android", supported: true, version: "127" },
				{ name: "Firefox Android", supported: true, version: "4" },
				{ name: "Opera Android", supported: true, version: "84" },
				{ name: "Safari iOS", supported: true, version: "16.4" },
				{ name: "Samsung Internet", supported: false, version: "No" },
			],
		},
	];
</script>

<div class="mx-auto w-5xl py-10">
	<Table.Root>
		<Table.Header>
			<Table.Row
				class="border-y-0 *:border-border hover:bg-transparent [&>:not(:last-child)]:border-r"
			>
				<Table.Cell />
				<Table.Head class="border-b text-center" colspan={5}>
					<MonitorIcon  class="inline-flex" size={16} />
					<span class="sr-only">Desktop browsers</span>
				</Table.Head>
				<Table.Head class="border-b text-center" colspan={5}>
					<SmartphoneIcon  class="inline-flex" size={16} />
					<span class="sr-only">Mobile browsers</span>
				</Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Header>
			<Table.Row class="*:border-border hover:bg-transparent [&>:not(:last-child)]:border-r">
				<Table.Cell />
				{#each items[0].desktop as browser}
					<Table.Head class="h-auto py-3 align-bottom text-foreground">
						<span
							class="relative left-[calc(50%-.5rem)] block rotate-180 leading-4 whitespace-nowrap [text-orientation:sideways] [writing-mode:vertical-rl]"
						>
							{browser.name}
						</span>
					</Table.Head>
				{/each}
				{#each items[0].mobile as browser}
					<Table.Head class="h-auto py-3 align-bottom text-foreground">
						<span
							class="relative left-[calc(50%-.5rem)] block rotate-180 leading-4 whitespace-nowrap [text-orientation:sideways] [writing-mode:vertical-rl]"
						>
							{browser.name}
						</span>
					</Table.Head>
				{/each}
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each items as item}
			{const rowItem = [...item.desktop, ...item.mobile]}
				<Table.Row class="*:border-border [&>:not(:last-child)]:border-r">
					<Table.Head class="font-medium text-foreground">
						{item.feature}
					</Table.Head>
					{#each rowItem as browser,index}
              <Table.Cell
                class="space-y-1 text-center"
              >
			  {#if browser.supported}
				<CheckIcon
					class="inline-flex stroke-emerald-600"
					size={16}
				/>
				{:else}
				<XIcon
					class="inline-flex stroke-red-600"
					size={16}
				/>
			  {/if}
                <span class="sr-only">
                  {browser.supported ? "Supported" : "Not supported"}
                </span>
                <div class="font-medium text-muted-foreground text-xs">
                  {browser.version}
                </div>
              </Table.Cell>
					{/each}
				</Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
</div>
