# RapStore Assistant

Discord digital-store bot built with discord.js v14 and MongoDB Atlas. **All bot-generated messages use Discord Components V2; classic embeds are not used.** Payments are manual via the store's own GoPay Merchant QR. No payment gateway is integrated and no screenshot is treated as proof that money arrived.

## Requirements
- Node.js 20.18+ (Node.js 22 LTS recommended)
- Discord application/bot with a token
- MongoDB Atlas cluster and database user
- Bot invited with permission to use slash commands, create/manage ticket channels, send messages, and read message history

## Install on Termux or Linux VPS
```bash
git clone https://github.com/ReyinGamerz/RapStore-Assistant.git
cd RapStore-Assistant
npm install
cp .env.example .env
nano .env
npm run check
npm run commands:refresh
npm start
```

Fill `.env` locally; never commit `.env` or paste its contents into chat. Set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `MONGODB_URI`. Slash commands are registered globally only. `DISCORD_GUILD_ID` is not used for registration. Global commands can take time to propagate. Refreshing uses Discord bulk-overwrite, so obsolete global commands not present in `src/commands.js` are removed.

Set `RESELLER_ROLE_ID` in `.env` to the exact Discord Reseller role ID. If omitted, reseller pricing is not assigned to any role. Configure the bot's role hierarchy and permissions in Discord. The configured Founder and Admin role IDs are read from environment variables, with the server IDs supplied for RapStore as defaults. Make sure the bot can create channels under the configured order category and that the configured IDs belong to the intended server.

## Interface standard
All replies, ticket messages, payment-review notices, delivery messages, and vouch announcements are sent using Components V2 containers and text-display components. No classic Discord embeds or ordinary message-content payloads are used.

## Commands
### Public/buyer
- `/ping` — Discord and MongoDB ping.
- `/store` — payment and store information.
- `/catalog` — interactive buyer catalog: choose category, then product, then view retail/reseller price and stock.
- `/order_create produk_id jumlah` — creates a private order channel for 1–5 items.
- `/payment_submit kode_order bukti` — submits an image proof for manual review.
- `/vouch kode_order rating ulasan` — one vouch per delivered order.

### Admin/Founder
- `/panel` — private Founder/Admin management panel with buttons to add products, edit product fields/prices/category, add stock, and list products.
- `/product_add` — legacy product creation command; `/panel` is the easier workflow.
- `/product_manage` — legacy command to list product IDs and enable/disable a product; use `/panel` for editing product fields.
- `/stock_add produk_id items` — adds up to 100 unique lines of digital stock per invocation.
- `/payment_review kode_order keputusan catatan` — manually approves/rejects the latest pending proof.
- `/order_deliver kode_order` — retries delivery using the same allocated stock.
- `/ticket_close` — locks an order ticket; it does not mean the order is completed.

## Important operational limitations
- The GoPay QR image is not bundled. Upload your own QR image and present it to buyers using your chosen trusted store process.
- Admin must check the actual merchant transaction before running `/payment_review ... keputusan:approve`.
- Stock items are sensitive. Add stock only in a private staff context. Avoid putting real credentials or personal data into stock items.
- Delivery attempts are tracked separately for DM and ticket. If one destination fails, use `/order_deliver`; the same allocated item is reused. Review duplicate messages manually before repeated retries.
- The order and stock updates use conditional MongoDB writes, but this workflow is not a multi-document transaction. In a crash or database/network failure during payment approval, reconcile the order, stock reservation, and payment proof before retrying. Do not blindly approve again.
- Ticket close locks the channel; automatic delayed archival is not yet implemented. Staff must move/organize locked tickets manually.
- Support-ticket panel, automated coupon handling, refund workflow, backup automation, and a full automated test suite are not implemented yet.
- Configure MongoDB Atlas Network Access narrowly; do not open database access to the whole internet. Back up the database and test restoration.

## Before production
Run through a test server with fake stock and a test order. Check buyer/staff permissions, insufficient stock, duplicate SKU/stock, closed DMs, inaccessible ticket channels, repeated proof submission, and restart/recovery after interrupted operations. Do not sell live inventory until these checks pass.
