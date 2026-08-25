<script lang="ts">
	import * as Table from "$lib/components/ui/table/index.js";
	import { Checkbox } from "$lib/components/ui/checkbox";
	let items = $state([
		{
			balance: "$1,250.00",
			email: "alex.t@company.com",
			id: "1",
			location: "San Francisco, US",
			name: "Alex Thompson",
			selected: false,
			status: "Active",
		},
		{
			balance: "$600.00",
			email: "sarah.c@company.com",
			id: "2",
			location: "Singapore",
			name: "Sarah Chen",
			selected: false,
			status: "Active",
		},
		{
			balance: "$650.00",
			email: "j.wilson@company.com",
			id: "3",
			location: "London, UK",
			name: "James Wilson",
			selected: false,
			status: "Inactive",
		},
		{
			balance: "$0.00",
			email: "m.garcia@company.com",
			id: "4",
			location: "Madrid, Spain",
			name: "Maria Garcia",
			selected: false,
			status: "Active",
		},
		{
			balance: "-$1,000.00",
			email: "d.kim@company.com",
			id: "5",
			location: "Seoul, KR",
			name: "David Kim",
			selected: false,
			status: "Active",
		},
	]);

	let allRowsSelected = $derived(items.length > 0 && items.every((item) => item.selected));
	let someRowsSelected = $derived(items.some((item) => item.selected) && !allRowsSelected);

	function setAllRows(selected: boolean) {
		for (const item of items) {
			item.selected = selected;
		}
	}
</script>

<div class="mx-auto w-4xl py-10">
	<div class="overflow-hidden rounded-md border bg-background">
		<Table.Root class="w-full">
			<Table.Header>
				<Table.Row>
					<Table.Head>
						<Checkbox
							aria-label="Select all rows"
							checked={allRowsSelected}
							indeterminate={someRowsSelected}
							onCheckedChange={(checked) => setAllRows(checked)}
						/>
					</Table.Head>
					<Table.Head>Name</Table.Head>
					<Table.Head>Email</Table.Head>
					<Table.Head>Location</Table.Head>
					<Table.Head>Status</Table.Head>
					<Table.Head class="text-right">Balance</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each items as item (item.id)}
					<Table.Row data-state={item.selected ? "selected" : undefined}>
						<Table.Cell>
							<Checkbox
								aria-label={`Select ${item.name}`}
								bind:checked={item.selected}
							/>
						</Table.Cell>
						<Table.Cell class="font-medium">{item.name}</Table.Cell>
						<Table.Cell>{item.email}</Table.Cell>
						<Table.Cell>{item.location}</Table.Cell>
						<Table.Cell>{item.status}</Table.Cell>
						<Table.Cell class="text-end">{item.balance}</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
			<Table.Footer class="bg-transparent">
				<Table.Row class="hover:bg-transparent">
					<Table.Cell colspan={5}>Total</Table.Cell>
					<Table.Cell class="text-right">$2,500.00</Table.Cell>
				</Table.Row>
			</Table.Footer>
		</Table.Root>
	</div>
	<p class="mt-4 text-center text-sm text-muted-foreground">Card Table</p>
</div>
