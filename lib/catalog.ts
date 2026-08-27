//#region src/catalog.d.ts
var [CatalogEntry] = [
	0,
	() => [],
	[
		"",
		"",
		""
	]
];
var [CatalogServer] = [
	1,
	() => [CatalogEntry],
	[
		"",
		"",
		"",
		""
	]
];
var [Catalog] = [
	2,
	() => [CatalogServer, Record],
	["", ""]
];
var [SearchHit] = [
	3,
	() => [CatalogEntry],
	[
		"",
		"",
		""
	]
];
var [serverOfMcp] = [
	4,
	() => [],
	[""]
];
var [snapshotFromSchemas] = [
	5,
	() => [ReadonlyArray, CatalogEntry],
	[
		"",
		"",
		"",
		"",
		"",
		"",
		""
	]
];
var [searchCatalog] = [
	6,
	() => [Catalog, SearchHit],
	[
		"",
		"",
		"",
		"",
		""
	]
];
var [listServer] = [
	7,
	() => [Catalog, Array],
	[
		"",
		"",
		"",
		"",
		"",
		""
	]
];
var [catalogFileFor] = [
	8,
	() => [],
	[""]
];
var [loadCatalog] = [
	9,
	() => [Catalog, Promise],
	[
		"",
		"",
		""
	]
];
var [saveCatalog] = [
	10,
	() => [Catalog, Promise],
	[
		"",
		"",
		"",
		""
	]
];
//#endregion
export { Catalog, CatalogEntry, CatalogServer, SearchHit, catalogFileFor, listServer, loadCatalog, saveCatalog, searchCatalog, serverOfMcp, snapshotFromSchemas };
