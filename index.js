import fs from "fs";
import express from "express";
import fetch from "node-fetch";
import { Client, GatewayIntentBits, REST, Routes } from "discord.js";
import adminCommands from "./commands/admin.js";

const { CLIENT_ID, CLIENT_SECRET, BOT_TOKEN, APP_ID, BASE_URL } = process.env;

if (!CLIENT_ID || !CLIENT_SECRET || !BOT_TOKEN || !APP_ID || !BASE_URL) {
  console.error("Set CLIENT_ID, CLIENT_SECRET, BOT_TOKEN, APP_ID, BASE_URL in env.");
  process.exit(1);
}

const STORAGE = "storage.json";
const storage = fs.existsSync(STORAGE) ? JSON.parse(fs.readFileSync(STORAGE)) : { tokens: {}, mappings: {} };

function saveStorage() {
  fs.writeFileSync(STORAGE, JSON.stringify(storage, null, 2));
}

function oauthAuthorizeUrl(redirectPath = "/callback") {
  const redirect_uri = `${BASE_URL}${redirectPath}`;
  const scope = "identify role_connections.write";
  return `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(
    redirect_uri
  )}&response_type=code&scope=${encodeURIComponent(scope)}`;
}

async function exchangeCodeForToken(code, redirectPath = "/callback") {
  const redirect_uri = `${BASE_URL}${redirectPath}`;
  const params = new URLSearchParams();
  params.append("client_id", CLIENT_ID);
  params.append("client_secret", CLIENT_SECRET);
  params.append("grant_type", "authorization_code");
  params.append("code", code);
  params.append("redirect_uri", redirect_uri);
  const r = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  return r.ok ? r.json() : Promise.reject(await r.text());
}

async function getUserFromToken(access_token) {
  const r = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${access_token}` }
  });
  if (!r.ok) throw new Error("Failed to /users/@me: " + (await r.text()));
  return r.json();
}

async function writeRoleConnection(access_token, app_id, metadataObj) {
  const url = `https://discord.com/api/v10/users/@me/applications/${app_id}/role-connection`;
  const body = {
    platform_name: "Linked Roles App",
    platform_username: metadataObj.platform_username || undefined,
    metadata: metadataObj.metadata
  };
  if (!body.platform_username) delete body.platform_username;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const txt = await r.text();
    console.warn("writeRoleConnection failed:", r.status, txt);
    return { ok: false, status: r.status, text: txt };
  }
  return { ok: true };
}

async function registerMetadata(metadataArray) {
  const url = `https://discord.com/api/v10/applications/${APP_ID}/role-connections/metadata`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(metadataArray)
  });
  if (!res.ok) {
    console.warn("Failed to register metadata:", await res.text());
    return false;
  }
  console.log("Metadata registered/updated.");
  return true;
}

/* ---------- Express ---------- */
const app = express();
app.get("/", (req, res) => res.send("Linked roles app is running."));
app.get("/connect", (req, res) => res.redirect(oauthAuthorizeUrl("/callback")));
app.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code.");
  try {
    const tokenResp = await exchangeCodeForToken(code, "/callback");
    const user = await getUserFromToken(tokenResp.access_token);
    storage.tokens[user.id] = {
      access_token: tokenResp.access_token,
      refresh_token: tokenResp.refresh_token,
      scope: tokenResp.scope,
      obtained_at: Date.now()
    };
    saveStorage();
    res.send(`Thanks ${user.username}! Your account is connected.`);
  } catch (err) {
    console.error("callback error", err);
    res.status(500).send("OAuth failed: " + String(err));
  }
});

/* ---------- discord.js bot ---------- */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.on("ready", async () => {
  console.log("Bot ready", client.user.tag);
});

/* Register admin slash commands (global) */
const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
(async () => {
  try {
    console.log("Registering admin commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: adminCommands });
    console.log("Admin commands registered globally.");
  } catch (err) {
    console.error("Failed to register commands", err);
  }
})();

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;
  const { commandName } = interaction;

  if (commandName === "register_metadata") {
    if (!interaction.memberPermissions.has("ManageGuild"))
      return interaction.reply({ content: "You need Manage Server.", ephemeral: true });
    const key = interaction.options.getString("key");
    const name = interaction.options.getString("name");
    const description = interaction.options.getString("description");
    const type = interaction.options.getInteger("type");
    const meta = [{ key, name, description, type }];
    const ok = await registerMetadata(meta);
    if (ok) interaction.reply({ content: "Metadata registered (bot) — Guilds can now use it in Links.", ephemeral: true });
    else interaction.reply({ content: "Failed to register metadata. Check logs.", ephemeral: true });
  }

  if (commandName === "map_role") {
    if (!interaction.memberPermissions.has("ManageGuild"))
      return interaction.reply({ content: "You need Manage Server.", ephemeral: true });
    const role = interaction.options.getRole("source_role");
    const key = interaction.options.getString("metadata_key");
    const guildId = interaction.guildId;
    if (!storage.mappings[guildId]) storage.mappings[guildId] = {};
    storage.mappings[guildId][role.id] = key;
    saveStorage();
    interaction.reply({ content: `Mapped ${role.name} -> ${key}`, ephemeral: true });
  }

  if (commandName === "unmap_role") {
    if (!interaction.memberPermissions.has("ManageGuild"))
      return interaction.reply({ content: "You need Manage Server.", ephemeral: true });
    const role = interaction.options.getRole("source_role");
    const guildId = interaction.guildId;
    if (storage.mappings[guildId] && storage.mappings[guildId][role.id]) {
      delete storage.mappings[guildId][role.id];
      saveStorage();
      interaction.reply({ content: `Unmapped ${role.name}`, ephemeral: true });
    } else interaction.reply({ content: "No mapping found.", ephemeral: true });
  }
});

function roleSetFrom(member) {
  return new Set(member.roles.cache.map((r) => r.id));
}

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  try {
    const before = roleSetFrom(oldMember);
    const after = roleSetFrom(newMember);
    const guildId = newMember.guild.id;
    const guildMap = storage.mappings[guildId] || {};

    for (const [sourceRoleId, metadataKey] of Object.entries(guildMap)) {
      const had = before.has(sourceRoleId);
      const hasNow = after.has(sourceRoleId);
      if (had === hasNow) continue;

      const userId = newMember.id;
      const info = storage.tokens[userId];
      if (!info) {
        try {
          await newMember.send(`To enable linked roles, connect here: ${BASE_URL}/connect`);
        } catch (e) {}
        continue;
      }

      const val = hasNow ? "1" : "0";
      const result = await writeRoleConnection(info.access_token, APP_ID, {
        metadata: { [metadataKey]: val },
        platform_username: newMember.user.username
      });

      if (result.ok) console.log(`Updated ${userId} ${metadataKey}=${val}`);
      else console.warn("Failed to update role connection for", userId, result);
    }
  } catch (e) {
    console.error("guildMemberUpdate error", e);
  }
});

client.login(BOT_TOKEN).catch(console.error);
