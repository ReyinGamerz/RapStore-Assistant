# RapStore Assistant

Discord digital-store bot built with Node.js, discord.js v14, MongoDB Atlas, and Discord Components V2.

## Requirements
- Node.js 20.18+
- Discord bot token and application client ID
- MongoDB Atlas URI

## Install / update on Termux
For an existing checkout:
```bash
cd ~/RapStore-Assistant
git pull
npm run check
npm start
```

For a new install, run `npm install`, copy `.env.example` to `.env`, then set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `MONGODB_URI`. Never commit or share `.env`. Global slash command changes can take time to appear in Discord.

## Active commands
- `/catalog` — private interactive catalog, separated per user.
- `/panel` — private Founder/Admin panel for category and product management.
- **Edit product:** selecting a product opens its edit form directly. Change the category by entering the exact name of an existing category; new or misspelled category names are rejected.
- **Delete product:** available from the panel and requires confirmation.
- **Delete category:** requires confirmation and deletes all products assigned to that category as well. The built-in `Umum` category cannot be deleted.
- Edit/delete pickers show up to 25 options at a time, matching Discord's select-menu limit.

## Catalog display
- Header: `### 🛍️ RAPSTORE — CATALOG`
- Category label: `**Category:** Umum`
- Product names and prices are rendered in bold; Server Boost multipliers and month count are formatted with separate backticks. The custom `alur` emoji appears with one space before **Harga:**.
- Descriptions and reseller pricing are not shown.
- Products come from the MongoDB `products` collection and only active products are displayed. Add or edit intended products in `/panel` with their correct category and price.
- The category, product, and ticket-purpose menus remain below the list. `ORDER SEKARANG` creates an order ticket; `TANYA-TANYA DULU` creates a consultation ticket.

## Tickets
- Order channels use persistent sequential names such as `rap-1`, `rap-2`; consultation channels use a separate counter such as `tanya-0`, `tanya-1`.
- Counters are stored in MongoDB's `counters` collection and are not reused when a ticket closes or the bot restarts. If channel creation fails after a number is allocated, that number can be skipped rather than reused.
- Each user can have only one open ticket per server, regardless of ticket type.
- Tickets are created under `SUPPORT_CATEGORY_ID`.
- Consultation tickets are for discussion and keep the existing confirmed-close flow.
- Order tickets create a MongoDB order record and a Components V2 panel with category, product, amount (1–25), unit price, total price, and status. Total price is recalculated when a selection changes.
- Order statuses: `ON HOLD`, `PROSES`, `DONE`, and `CANCELLED`. Cancelling is available while the order is `ON HOLD` and requires confirmation. It updates the order and ticket records, locks the buyer out of the channel, and renames the channel with a `closed-` prefix. Once processing starts, cancellation is disabled.
- Founder/Admin can mark an order `DONE` after it reaches `PROSES`.

## Manual payment configuration
Set these values in the local `.env` file after confirming the store's actual payment details:
- `PAYMENT_QRIS_IMAGE_URL` — HTTPS URL of the correct QRIS image.
- `PAYMENT_BANK_NAME` — bank name.
- `PAYMENT_BANK_ACCOUNT_NAME` — recipient/account holder name.
- `PAYMENT_BANK_ACCOUNT_NUMBER` — account number.

QRIS and bank details are not bundled in the repository. If the corresponding configuration is empty, the bot refuses to display payment instructions rather than inventing payment details. After transfer, the buyer can attach a proof file in the order ticket. Founder/Admin receives a Components V2 verification panel with `PROSES` and `TIDAK VALID` actions. Accepting a proof marks payment verified and moves the order to `PROSES`; rejecting it asks the buyer to resend proof. Manual proof review does not automatically verify funds with a bank or payment provider.

## Components V2 and security
- All newly implemented order/payment messages use Discord Components V2; they do not use classic embeds.
- The bot needs permission to manage channels and channel permission overwrites in the configured support category.
- Configure `FOUNDER_ROLE_ID` and `ADMIN_ROLE_ID` for the intended roles.
- The bot uses the `GuildMessages` and privileged `MessageContent` intents to detect order-ticket attachments. Enable **Message Content Intent** in the Discord Developer Portal, or proof attachments may not be visible to the bot.
- Keep the bot token, MongoDB URI, and private configuration out of GitHub. Configure MongoDB Atlas network access narrowly.
