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
git pull origin main
npm install
npm run commands:refresh
npm start
```

For a new install, run `npm install`, copy `.env.example` to `.env`, then set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `MONGODB_URI`. `DISCORD_GUILD_ID` is not used. Slash commands are registered globally, and the refresh script removes old guild-scoped copies from every server the bot is currently in. Never commit or share `.env`. If the bot is managed by PM2, restart the existing process rather than starting a duplicate instance.

## Active commands
- `/catalog` — Founder/Admin-only command to create or sync the public catalog message. Members use the public catalog message itself.
- `/panel` — Founder/Admin-only, private (ephemeral) management panel. It never posts a new public management panel.
- Slash commands are registered globally and do not require `DISCORD_GUILD_ID`. On refresh, the bot replaces the global command set and clears legacy guild-scoped command copies from every server the bot is currently in. Runtime role checks remain authoritative even if Discord temporarily caches old command metadata.
- The bot refreshes the saved public catalog on startup and removes any legacy public management-panel message recorded by older versions. Catalog data is refreshed after product/category changes made through the private `/panel`.
- Ticket creation shows a temporary “TIKET SEDANG DIBUAT” status before reporting success or failure.
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
- Every ticket receives one random public `ticketCode` (5–10 characters, e.g. `&JI$U`). The same code is stored on the ticket and order, displayed below the order status, included in the ticket channel topic, and used in the transcript HTML filename. The MongoDB `_id` remains an internal database key. This shared code is intended to support future lookups such as `/cektranscript ID`.
- Counters are stored in MongoDB's `counters` collection and are not reused when a ticket closes or the bot restarts. If channel creation fails after a number is allocated, that number can be skipped rather than reused.
- Each user can have only one open ticket per server, regardless of ticket type.
- Tickets are created under `SUPPORT_CATEGORY_ID`. Category and product dropdowns in order tickets reuse their saved custom/unicode emojis from the catalog.
- Consultation tickets are for discussion and keep the confirmed-close flow. Closing a ticket uploads a readable HTML transcript with a random five-character suffix (for example `rap-1-#8buH7.html`) to `TRANSCRIPT_CHANNEL_ID`, then deletes the Discord ticket channel.
- HTML transcripts use a Discord-inspired dark layout with author avatars/display names, timestamps, bot badges, replies where the referenced message is present in the archived history, message text, Components V2 panels and media galleries, and classic embed cards. Image attachments are reposted into `TRANSCRIPT_CHANNEL_ID` first; the transcript HTML is then uploaded and uses the new Discord attachment URLs for image previews. Non-image files are not copied to the archive. If any photo cannot be archived or the transcript cannot be uploaded, archive fails safely and the original ticket channel is retained. Photo uploads use stable markers so an interrupted archive retry can reuse previously copied photos rather than uploading duplicates.
- Founder/Admin can use `!close` in any open ticket to archive the transcript immediately. An unfinished order is marked `CANCELLED` and pending payment proofs are superseded so a deleted ticket cannot leave a payable/processable order behind. The bot uploads the HTML transcript first and only then marks the ticket closed and deletes the channel. If transcript upload fails, the channel is retained and the bot posts an error notice.
- Ticket archival uses a MongoDB `closing` claim to avoid simultaneous archive attempts. Interrupted `closing` tickets are retried by maintenance, including after a restart. A stable archive marker is checked in recent transcript-channel history before retrying an upload, reducing duplicate transcript files if Discord accepted an upload but the database update failed.
- Auto-close distinguishes Discord's definitive `Unknown Channel` response from temporary API/permission errors. Temporary failures are retried; if the ticket channel was actually deleted before a transcript could be made, the ticket is marked `missing_channel` and the order is flagged for manual review rather than falsely claiming a transcript was archived.
- Order tickets create a MongoDB order record and a Components V2 panel with category, product, amount (1–25), unit price, total price, and status. Total price is recalculated when a selection changes.
- Payment proof review cards are stored by message/channel ID and can be recovered by maintenance after a transient send/database error. When Founder/Admin approves or rejects a proof, the same review message is replaced with a final result panel; the ticket order panel and order log are refreshed independently so a refresh failure does not block the review-message update. Old or superseded proof cards have their action buttons removed when accessible.
- Order statuses: `ON HOLD`, `PROSES`, `DONE`, and `CANCELLED`. Cancelling is available while the order is `ON HOLD` and requires confirmation. The bot archives a transcript before deleting the ticket. Once processing starts, cancellation is disabled.
- Founder/Admin can mark an order `DONE` using the button or `!done` in the order ticket, after it reaches `PROSES`.
- Marking an order `DONE` adds a `VOUCH` button. The buyer can submit a 1–5 rating and a message; the bot publishes one Components V2 customer-testimonial panel to `VOUCH_CHANNEL_ID`. If no vouch is submitted within one hour, a 5/5 automatic vouch with the text `vouch otomatis setelah 1 jam.` is published.
- After a buyer vouch is successfully published, the bot immediately creates the HTML transcript and closes/deletes that order ticket. If no vouch is submitted, the same archive-and-close flow runs after the one-hour automatic vouch. The scheduled job retries after restarts and temporary configuration/permission failures; a ticket is not deleted if the transcript cannot be uploaded.
- Order tickets create/update a Components V2 order log in `ORDER_LOG_CHANNEL_ID` with status, buyer, product, quantity, total price, date, and order ID. Consultation (`tanya-*`) tickets do not create order logs.

## Manual payment configuration
Set these values in the local `.env` file after confirming the store's actual payment details:
- `PAYMENT_QRIS_IMAGE_URL` — HTTPS URL of the correct QRIS image.
- `PAYMENT_BANK_NAME` — bank name.
- `PAYMENT_BANK_ACCOUNT_NAME` — recipient/account holder name.
- `PAYMENT_BANK_ACCOUNT_NUMBER` — account number.
- `VOUCH_CHANNEL_ID` — Discord text channel where customer testimonials are published.
- `TRANSCRIPT_CHANNEL_ID` — Discord text channel where image attachments are copied first and the HTML ticket transcript is archived before the original ticket channel is deleted. No external cloud-storage credentials are required.
- `ORDER_LOG_CHANNEL_ID` — Discord text channel where order-only status logs are posted and updated.

QRIS and bank details are not bundled in the repository. If the corresponding configuration is empty, the bot refuses to display payment instructions rather than inventing payment details. After transfer, the buyer can attach a proof file in the order ticket. Founder/Admin receives a Components V2 verification panel with `PROSES` and `TIDAK VALID` actions. Accepting a proof marks payment verified and moves the order to `PROSES`; rejecting it asks the buyer to resend proof. Manual proof review does not automatically verify funds with a bank or payment provider.

## Components V2 and security
- All newly implemented order/payment messages use Discord Components V2; they do not use classic embeds.
- Ticket creation uses a unique MongoDB reservation per server/user to reject concurrent double-clicks; abandoned reservations expire automatically.
- Payment-proof uploads are limited to five attachments and 15 MB total per message. Conditional MongoDB updates prevent payment/order controls from overwriting a proof already submitted.
- Transcript generation is capped at 2,000 messages and 100 MB total attachment size. If a ticket exceeds either limit, archival stops and the original ticket channel is retained for manual review.
- The built-in `Umum` category is protected in both the confirmation UI and the final deletion handler.
- Run `npm test` and `npm run check` before deploying. These tests cover proof-attachment validation; they do not replace a live Discord/MongoDB integration test.
- The bot needs permission to manage channels and channel permission overwrites in the configured support category. For transcript archival/recovery, it also needs View Channel, Read Message History, Send Messages, and Attach Files in `TRANSCRIPT_CHANNEL_ID`.
- Configure `FOUNDER_ROLE_ID` and `ADMIN_ROLE_ID` for the intended roles.
- The bot uses the `GuildMessages` and privileged `MessageContent` intents to detect order-ticket attachments. Enable **Message Content Intent** in the Discord Developer Portal, or proof attachments may not be visible to the bot.
- Keep the bot token, MongoDB URI, and private configuration out of GitHub. Configure MongoDB Atlas network access narrowly.
