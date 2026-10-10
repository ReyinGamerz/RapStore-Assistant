# RapStore Assistant — Catalog Only

Discord catalog bot built with discord.js v14, MongoDB Atlas, and Discord Components V2. Current scope: catalog browsing and product management only.

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
- Products come from the MongoDB `products` collection and only active products are displayed. Add or edit the intended products in `/panel`, e.g. `Server Boost 2x 1 Month`, `Server Boost 4x 1 Month`, and `Server Boost 6x 1 Month`, with the correct prices and category.
- The category, product, and ticket-purpose menus remain below the list. `ORDER SEKARANG` and `TANYA-TANYA DULU` remain temporarily.

## Out of scope
Standalone order, stock, payment, delivery, ticket-close, vouch, store-info, and ping slash commands are not active. Ticket creation is handled from the catalog's `ORDER SEKARANG` and `TANYA-TANYA DULU` menu options.
- Each user can have only one open ticket per server, regardless of ticket type.
- Tickets are created under `SUPPORT_CATEGORY_ID` and include the selected active product when one was selected.
- The ticket owner and Founder/Admin can request closure. Closing requires confirmation, marks the ticket closed in MongoDB, locks the owner's access, and renames the channel with a `closed-` prefix.
- The bot needs permission to manage channels and channel permission overwrites in the configured support category.

## Security
Keep the bot token and MongoDB URI private. Configure MongoDB Atlas network access narrowly. Use the intended Founder/Admin role IDs for your server.
