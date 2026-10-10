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
- `/panel` — private Founder/Admin panel with add product, edit product, and product list.

## Catalog display
- Header: `### 🛍️ RAPSTORE — CATALOG`
- Category label: `**Category:** Umum`
- Product names and prices are rendered in bold; Server Boost multipliers and month count are formatted with separate backticks.
- Descriptions and reseller pricing are not shown.
- Products come from the MongoDB `products` collection and only active products are displayed. Add or edit the intended products in `/panel`, e.g. `Server Boost 2x 1 Month`, `Server Boost 4x 1 Month`, and `Server Boost 6x 1 Month`, with the correct prices and category.
- The category, product, and ticket-purpose menus remain below the list. `ORDER SEKARANG` and `TANYA-TANYA DULU` remain temporarily.

## Out of scope
Standalone order, stock, payment, delivery, ticket-close, vouch, store-info, and ping commands are not active. Reseller pricing and stock management have been removed from the panel.

## Security
Keep the bot token and MongoDB URI private. Configure MongoDB Atlas network access narrowly. Use the intended Founder/Admin role IDs for your server.
