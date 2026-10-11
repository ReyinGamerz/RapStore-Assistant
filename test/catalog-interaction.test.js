import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const orderSource = readFileSync(new URL("../src/order-system.js", import.meta.url), "utf8");
const catalogStateSource = readFileSync(new URL("../src/catalog-state.js", import.meta.url), "utf8");
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

test("category selection updates the shared public catalog for everyone", () => {
  const category = section(
    "if (isCategory) {",
    'if (interaction.customId === "rapstore:catalog:product") {',
  );
  assert.match(category, /await interaction\.update\(await buildCatalogPayload\(category, ""\)\)/);
  assert.match(category, /await persistCatalogSelection\(interaction, category, ""\)/);
  assert.doesNotMatch(category, /ensureUserCatalogPanel|updateOwnedCatalogPanel|ownerId/);
  assert.match(source, /setCustomId\("rapstore:catalog:category"\)/);
  assert.match(source, /setCustomId\("rapstore:catalog:category-page:next:" \+ Math\.max\(0, categoryIndex\)\)/);
  assert.doesNotMatch(source, /function catalogPanelOwner|function ensureUserCatalogPanel|ownerSuffix/);
});
test("product selection updates the shared catalog and opens a separate ephemeral confirmation", () => {
  const product = section(
    'if (interaction.customId === "rapstore:catalog:product") {',
    "\n}\n\nasync function handleCatalogPageButton",
  );
  assert.match(product, /await interaction\.update\(await buildCatalogPayload\(category, id\)\)/);
  assert.match(product, /await persistCatalogSelection\(interaction, category, id\)/);
  assert.match(product, /Number\.isSafeInteger\(unitPrice\) \|\| unitPrice < 1/);
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
  assert.match(source, /async function handleCatalogPageButton\(interaction\)[\s\S]*?wrapCategoryIndex\(currentIndex, action, categories\.length\)/);
  assert.match(catalogStateSource, /function wrapCategoryIndex\(currentIndex, direction, categoryCount\)/);
  assert.match(source, /await handleCatalogPageButton\(interaction\); return;/);
});

test("catalog no longer exposes a ticket-destination dropdown", () => {
  assert.doesNotMatch(source, /rapstore:catalog:ticket/);
  assert.doesNotMatch(source, /Pilih Tujuan Tiket/);
  assert.match(source, /\.setCustomId\("rapstore:catalog:category" \+ ownerSuffix\)/);
  assert.match(source, /\.setCustomId\("rapstore:catalog:product" \+ ownerSuffix\)/);
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

test("catalog and management panel are public and use configured channel IDs", () => {
  assert.match(source, /async function showFounderPanel\(interaction\)[\s\S]*?await upsertPersistentPanel\(interaction, "panel", buildFounderPanelPayload\(\)\)/);
  assert.match(source, /configuredPanelChannelId\(type\)/);
  assert.match(source, /catalog: optionalId\("CATALOG_CHANNEL", "1551251028522045470"\)/);
  assert.match(source, /adminPanel: optionalId\("CATALOG_ADMIN_PANEL", "1558775847421354075"\)/);
  assert.match(source, /if \(interaction\.commandName === "catalog"\)[\s\S]*?if \(!hasStaffRole\(interaction\.member\)\)/);
  assert.match(source, /await upsertPersistentPanel\(interaction, "catalog", await buildCatalogPayload\(savedCatalog\?\.selectedCategory/);
  assert.match(source, /async function handleAddEmojiCommand\(interaction\)[\s\S]*?if \(!hasFounderRole\(interaction\.member\)\)/);
  assert.match(source, /interaction\.guild\.emojis\.create/);
});

test("order ticket creation no longer sends the extra INFO PESANAN message", () => {
  assert.doesNotMatch(orderSource, /INFO PESANAN/);
});

test("catalog uses the requested custom alur and Catalog emojis", () => {
  assert.ok(source.includes("<:alur:1558458209977499740> **Harga:**"));
  assert.match(source, /### <:Catalog:1558470276981850132> RAPSTORE — CATALOG/);
  assert.doesNotMatch(source, /<:alur:1553800809198649344>/);
});
