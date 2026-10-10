import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const orderSource = readFileSync(new URL("../src/order-system.js", import.meta.url), "utf8");
const catalogStart = source.indexOf("async function handleCatalogSelection(interaction)");
const catalogEnd = source.indexOf("\nfunction formatPrice(", catalogStart);
assert.notEqual(catalogStart, -1, "catalog selection handler should exist");
assert.notEqual(catalogEnd, -1, "catalog selection handler should have a clear end");
const handler = source.slice(catalogStart, catalogEnd);

function section(startMarker, endMarker) {
  const start = handler.indexOf(startMarker);
  const end = handler.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing handler section: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return handler.slice(start, end);
}

test("category selection updates the original catalog message", () => {
  const category = section(
    'if (interaction.customId === "rapstore:catalog:category")',
    'if (interaction.customId === "rapstore:catalog:product")',
  );
  assert.match(category, /await interaction\.deferUpdate\(\)/);
  assert.match(category, /await interaction\.editReply\(await buildCatalogPayload\(category, ""\)\)/);
  assert.equal(category.includes("await interaction.deferReply("), false);
});

test("product selection keeps the public catalog and opens a separate ephemeral confirmation", () => {
  const product = section(
    'if (interaction.customId === "rapstore:catalog:product")',
    "\n}\n\nasync function handleCatalogPageButton",
  );
  assert.match(product, /await interaction\.deferUpdate\(\)/);
  assert.match(product, /await interaction\.editReply\(await buildCatalogPayload\(category, id\)\)/);
  assert.match(product, /KONFIRMASI PESANAN/);
  assert.match(product, /flags: EPHEMERAL \| MessageFlags\.IsComponentsV2/);
  assert.match(product, /rapstore:catalog:order:confirm:/);
  assert.match(product, /rapstore:catalog:order:cancel:/);
  assert.doesNotMatch(product, /rapstore:catalog:ticket/);
});

test("catalog category navigation displays a page counter and cycles categories", () => {
  assert.match(source, /const category = categories\.includes\(selectedCategory\) \? selectedCategory : \(categories\[0\] \|\| ""\)/);
  assert.match(source, /\.setCustomId\("rapstore:catalog:category-page:prev:"/);
  assert.match(source, /\.setCustomId\("rapstore:catalog:category-page:next:"/);
  assert.match(source, /\.setLabel\(pageLabel\)/);
  assert.match(source, /async function handleCatalogPageButton\(interaction\)[\s\S]*?\(currentIndex \+ delta \+ categories\.length\) % categories\.length/);
  assert.match(source, /await handleCatalogPageButton\(interaction\); return;/);
});

test("catalog no longer exposes a ticket-destination dropdown", () => {
  assert.doesNotMatch(source, /rapstore:catalog:ticket/);
  assert.doesNotMatch(source, /Pilih Tujuan Tiket/);
  assert.match(source, /\.setCustomId\("rapstore:catalog:category"\)/);
  assert.match(source, /\.setCustomId\("rapstore:catalog:product"\)/);
});

test("confirming an order revalidates the product and uses the guarded order-ticket flow", () => {
  const create = source.slice(
    source.indexOf("async function createCatalogOrderTicket"),
    source.indexOf("\nfunction formatPrice", source.indexOf("async function createCatalogOrderTicket")),
  );
  assert.match(create, /findOne\(\{ _id: new ObjectId\(selectedProductId\), active: true \}\)/);
  assert.match(create, /insertOne\(\{ guildId: interaction\.guildId, buyerId: interaction\.user\.id, interactionId: interaction\.id/);
  assert.match(create, /allocateTicketNumber\("order"\)/);
  assert.match(create, /initializeOrderTicket\(/);
  assert.match(create, /await interaction\.editReply\(payload\)/);
  assert.match(source, /async function handleCatalogOrderButton\(interaction\)[\s\S]*?action === "cancel"[\s\S]*?await interaction\.deleteReply\(\)/);
  assert.match(source, /action !== "confirm" \|\| !productId/);
  assert.match(source, /await createCatalogOrderTicket\(interaction, productId\)/);
});

test("order and support ticket counters use independent names", () => {
  const allocatorStart = orderSource.indexOf("async function allocateTicketNumber(kind)");
  const allocatorEnd = orderSource.indexOf("\nasync function orderCategories()", allocatorStart);
  assert.notEqual(allocatorStart, -1);
  assert.notEqual(allocatorEnd, -1);
  const allocator = orderSource.slice(allocatorStart, allocatorEnd);
  assert.match(allocator, /kind === "order" \? "ticket:order" : "ticket:support"/);
  assert.match(allocator, /kind === "order" \? "rap-" : "support-"/);
  assert.match(allocator, /const initial = kind === "order" \? 0 : -1/);
});

test("catalog is staff-published and the founder panel remains ephemeral", () => {
  assert.match(source, /async function showFounderPanel\(interaction\)[\s\S]*?flags: MessageFlags\.IsComponentsV2 \| MessageFlags\.Ephemeral/);
  assert.match(source, /if \(interaction\.commandName === "catalog"\)[\s\S]*?if \(!hasStaffRole\(interaction\.member\)\)/);
  assert.match(source, /await upsertPersistentPanel\(interaction, "catalog", await buildCatalogPayload\(\)\)/);
});

test("catalog uses the requested custom alur and Catalog emojis", () => {
  assert.ok(source.includes("<:alur:1558458209977499740> **Harga:**"));
  assert.match(source, /### <:Catalog:1558470276981850132> RAPSTORE — CATALOG/);
  assert.doesNotMatch(source, /<:alur:1553800809198649344>/);
});
