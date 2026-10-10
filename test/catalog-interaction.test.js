import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
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

test("product selection updates the original catalog message and keeps errors separate", () => {
  const product = section(
    'if (interaction.customId === "rapstore:catalog:product")',
    'if (interaction.customId === "rapstore:catalog:ticket")',
  );
  assert.match(product, /await interaction\.deferUpdate\(\)/);
  assert.match(product, /await interaction\.editReply\(await buildCatalogPayload\(category, id\)\)/);
  assert.doesNotMatch(product, /deferReply/);
  assert.match(product, /await interaction\.followUp\(payload\)/);
});

test("ticket creation acknowledges the catalog interaction without replacing the catalog", () => {
  const ticket = section(
    'if (interaction.customId === "rapstore:catalog:ticket")',
    "\n  }\n}",
  );
  assert.match(ticket, /await interaction\.deferUpdate\(\)/);
  assert.match(ticket, /interaction\.followUp\(/);
  assert.doesNotMatch(ticket, /deferReply/);
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
