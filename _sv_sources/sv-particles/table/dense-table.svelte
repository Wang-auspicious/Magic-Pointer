<script lang="ts">
	import * as Table from "$lib/components/ui/table/index.js";

	const programmingLanguages = [
		{
			developer: "Brendan Eich",
			extension: ".js",
			id: "1",
			latestVersion: "ES2021",
			name: "JavaScript",
			paradigm: "Multi-paradigm",
			popularity: "High",
			releaseYear: "1995",
			typing: "Dynamic",
		},
		{
			developer: "Guido van Rossum",
			extension: ".py",
			id: "2",
			latestVersion: "3.10",
			name: "Python",
			paradigm: "Multi-paradigm",
			popularity: "High",
			releaseYear: "1991",
			typing: "Dynamic",
		},
		{
			developer: "James Gosling",
			extension: ".java",
			id: "3",
			latestVersion: "17",
			name: "Java",
			paradigm: "Object-oriented",
			popularity: "High",
			releaseYear: "1995",
			typing: "Static",
		},
		{
			developer: "Bjarne Stroustrup",
			extension: ".cpp",
			id: "4",
			latestVersion: "C++20",
			name: "C++",
			paradigm: "Multi-paradigm",
			popularity: "High",
			releaseYear: "1985",
			typing: "Static",
		},
		{
			developer: "Yukihiro Matsumoto",
			extension: ".rb",
			id: "5",
			latestVersion: "3.0",
			name: "Ruby",
			paradigm: "Multi-paradigm",
			popularity: "Low",
			releaseYear: "1995",
			typing: "Dynamic",
		},
	];
</script>

<div class="mx-auto w-4xl py-10">
	<div class="overflow-hidden rounded-md border bg-background">
		<Table.Root class="w-full">
			<Table.Header>
				<Table.Row class="bg-muted/50">
					<Table.Head class="h-9 py-2">Name</Table.Head>
					<Table.Head class="h-9 py-2">Release Year</Table.Head>
					<Table.Head class="h-9 py-2">Developer</Table.Head>
					<Table.Head class="h-9 py-2">Typing</Table.Head>
					<Table.Head class="h-9 py-2">Paradigm</Table.Head>
					<Table.Head class="h-9 py-2">Extension</Table.Head>
					<Table.Head class="h-9 py-2">Latest Version</Table.Head>
					<Table.Head class="h-9 py-2">Popularity</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each programmingLanguages as item}
					<Table.Row>
						<Table.Cell class="font-medium">{item.name}</Table.Cell>
						<Table.Cell>{item.releaseYear}</Table.Cell>
						<Table.Cell>{item.developer}</Table.Cell>
						<Table.Cell>{item.typing}</Table.Cell>
						<Table.Cell>{item.paradigm}</Table.Cell>
						<Table.Cell>{item.extension}</Table.Cell>
						<Table.Cell>{item.latestVersion}</Table.Cell>
						<Table.Cell>{item.popularity}</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>
	<p class="mt-4 text-center text-muted-foreground text-sm">Dense table</p>
</div>
