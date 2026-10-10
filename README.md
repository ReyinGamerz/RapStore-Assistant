# RapStore Assistant — Catalog Only

Discord catalog bot built with discord.js v14, MongoDB Atlas, and Discord Components V2. The current scope is intentionally limited to browsing products and managing catalog entries.

## Requirements
- Node.js 20.18+
- Discord application/bot token and client ID
- MongoDB Atlas URI and database

## Install on Termux or Linux VPS
```bash
git clone https://github.com/ReyinGamerz/RapStore-Assistant.git
cd RapStore-Assistant
npm install
cp .env.example .env
nano .env
npm run check
npm start
```

Set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `MONGODB_URI` in `.env`. Never commit `.env` or share its contents. The bot refreshes global slash commands at startup; Discord may take some time to reflect removals.

## Active commands
- `/catalog` — private, interactive catalog. Select a category, browse its products, and choose a product. Each user's catalog interaction is separate.
- `/panel` — private Founder/Admin panel to add products, edit product details and prices, and view the product list.

## Catalog behavior
- Catalog messages use Components V2, not classic embeds.
- Product data comes from the `products` collection in MongoDB.
- Only active products appear.
- Category, product, and ticket-purpose menus are kept in the catalog.
- `ORDER SEKARANG` and `TANYA-TANYA DULU` currently create private ticket channels. This is a temporary ticket flow; full order/payment processing is not part of this catalog-focused version.
- Keep product names in the database in the intended display format, e.g. `Server Boost 2x 1 Month`.

## Not included in this phase
Standalone commands and workflows for order creation, stock entry, payment proof/review, delivery, ticket closing, vouch, store info, and ping have been removed from active slash-command registration. The product panel currently focuses on catalog management; inventory/order fulfillment will be considered later if needed.

## Security
Keep the bot token and MongoDB URI private. Configure MongoDB Atlas network access narrowly. Use the Founder/Admin role IDs intended for your server.
