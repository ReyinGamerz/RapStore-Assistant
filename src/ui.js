import {
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from "discord.js";

const MAX_TEXT_DISPLAY_LENGTH = 4000;

/**
 * Build a Components V2 container. This intentionally uses no classic embeds
 * and no message content field.
 */
export function buildPanel(title, body = "", sections = []) {
  const container = new ContainerBuilder();
  const titleText = String(title ?? "").trim();
  const bodyText = String(body ?? "").trim();

  if (titleText) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${titleText.slice(0, 200)}`),
    );
  }

  if (bodyText) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
    );
    for (const part of splitText(bodyText, MAX_TEXT_DISPLAY_LENGTH)) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(part));
    }
  }

  for (const section of sections) {
    const text = String(section ?? "").trim();
    if (!text) continue;
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
    );
    for (const part of splitText(text, MAX_TEXT_DISPLAY_LENGTH)) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(part));
    }
  }

  return container;
}

export function buildMessage(text, { title = "", ephemeral = false } = {}) {
  const body = String(text ?? "").trim() || "Tidak ada informasi untuk ditampilkan.";
  const chunks = splitText(body, MAX_TEXT_DISPLAY_LENGTH);
  const container = new ContainerBuilder();

  if (title) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${String(title).slice(0, 200)}`),
    );
  }
  for (const chunk of chunks) {
    if (title || container.components.length) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
      );
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(chunk));
  }

  return {
    flags: MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0),
    components: [container],
  };
}

export function buildComponentsOnly(text, { ephemeral = false } = {}) {
  return {
    flags: MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0),
    components: [buildPanel("", text)],
  };
}

function splitText(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < Math.floor(limit * 0.5)) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
