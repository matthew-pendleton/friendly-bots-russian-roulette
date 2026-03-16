// ── unfriendly-roulette ───────────────────────────────────────────────────────
// Part of the Unfriendly bot suite.
//
// App directory description:
//   Gather 2-3 players and take turns pulling the trigger. One bullet.
//   Six chambers. The loser gets timed out. Simple as that.
//
// Language:    English only
// DM support:  No (server-only)
// Status:      Playing: Unfriendly Roulette
// ─────────────────────────────────────────────────────────────────────────────

const {
  Client,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GatewayIntentBits,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  ActivityType,
} = require("discord.js");

const fs   = require("fs");
const path = require("path");

require("dotenv").config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
});

// ── Active game tracking ──────────────────────────────────────────────────────
const activeGames   = new Map(); // channelId → game state
const activePlayers = new Set(); // userId → in a game

// ── Config ────────────────────────────────────────────────────────────────────
const TIMEOUT_MINUTES      = 5;
const INVITE_TIMEOUT_MS    = 60000;
const PULL_DELAY_MS        = 2500;
const CHAMBERS             = 6;
const STATS_FILE           = path.join(__dirname, "stats.json");

// ── Stats persistence ─────────────────────────────────────────────────────────
function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
  } catch { /* corrupt — start fresh */ }
  return {};
}

function saveStats(stats) {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function recordResult(survivorIds, loserId) {
  const stats = loadStats();
  for (const id of survivorIds) {
    if (!stats[id]) stats[id] = { wins: 0, losses: 0 };
    stats[id].wins += 1;
  }
  if (!stats[loserId]) stats[loserId] = { wins: 0, losses: 0 };
  stats[loserId].losses += 1;
  saveStats(stats);
}

// ── Flavor text ───────────────────────────────────────────────────────────────
const CHALLENGE_TAUNTS = [
  (c, players) => `🔫 <@${c}> has loaded the cylinder and is inviting ${players} to play. Nobody has to do this. Somebody will.`,
  (c, players) => `🫀 <@${c}> spun the cylinder, looked ${players} dead in the eye, and said nothing. Just slid the gun across the table.`,
  (c, players) => `🎰 <@${c}> has proposed an unfriendly game of Russian Roulette to ${players}. The word "unfriendly" is doing a lot of work here.`,
  (c, players) => `🕯️ <@${c}> dimmed the lights, poured something they shouldn't have, and challenged ${players} to a round.`,
  (c, players) => `☠️ <@${c}> has extended an invitation to ${players}. It is not the kind of invitation you frame and put on a wall.`,
  (c, players) => `🩸 <@${c}> has decided that ${players} should play a game. The game involves one bullet and poor decision-making.`,
  (c, players) => `🎲 <@${c}> looked at ${players} and said "I feel lucky." This is not reassuring for anyone involved.`,
  (c, players) => `🌑 <@${c}> challenges ${players} to Russian Roulette. At least someone in this server has conviction.`,
];

const DECLINE_LINES = [
  (d) => `🐔 <@${d}> looked at the gun, looked at the table, and quietly left the room.`,
  (d) => `📵 <@${d}> declined. Smart, probably. Cowardly, definitely.`,
  (d) => `🧘 <@${d}> said they're in a really good headspace right now and a bullet would disrupt that.`,
  (d) => `🩹 <@${d}> cited a pre-existing condition. The condition is self-preservation.`,
  (d) => `🚶 <@${d}> stood up, nodded respectfully, and walked directly out of the server.`,
  (d) => `🍵 <@${d}> said they just made tea and the timing really doesn't work for them right now.`,
  (d) => `🔕 <@${d}> saw the invite, put their phone face-down, and resumed their day.`,
  (d) => `💅 <@${d}> said no with the energy of someone who has already moved on.`,
];

const TIMEOUT_LINES = [
  (c, d) => `⏱️ <@${d}> didn't respond to <@${c}>'s challenge. The gun sits on the table, unclaimed.`,
  (c, d) => `👻 <@${c}> set up the whole thing and <@${d}> just ghosted. The cylinder is still spinning.`,
  (c, d) => `🌊 <@${d}> left <@${c}> on read. The bullet waits for no one.`,
  (c, d) => `🦗 <@${c}> challenged <@${d}>. <@${d}> said nothing. Challenge expired.`,
  (c, d) => `🕰️ A minute passed. <@${d}> let it pass. The game does not wait.`,
];

const SAFE_PULL_FLAVOR = [
  (player) => `*click* — **${player}** pulls the trigger. Nothing. They're still here.`,
  (player) => `**${player}** pulls the trigger. The cylinder turns. Silence. 😮‍💨`,
  (player) => `**${player}** doesn't flinch. *click*. Empty chamber.`,
  (player) => `*click* — **${player}** exhales. Not today.`,
  (player) => `**${player}** pulls. The room holds its breath. Empty. 🫁`,
  (player) => `**${player}** goes for it. *click*. Alive. Somehow.`,
  (player) => `*click* — **${player}** is still with us. For now.`,
  (player) => `**${player}** pulls the trigger with the energy of someone who is either very brave or very stupid. Empty.`,
  (player) => `*click* — **${player}** doesn't even blink. Cold.`,
  (player) => `**${player}** pulls. Empty chamber. They slide the gun across the table without saying a word.`,
];

const LOSER_FLAVOR = [
  (player) => `💥 **${player}** pulls the trigger. The chamber wasn't empty. It's over.`,
  (player) => `💥 **${player}** — that was the one. Game over.`,
  (player) => `💥 Not **${player}**'s round. Not **${player}**'s day.`,
  (player) => `💥 **${player}** found the bullet. The bullet found **${player}**.`,
  (player) => `💥 **${player}** pulls. The cylinder had one job. It did its job.`,
  (player) => `💥 And just like that, **${player}** is done. The game always wins.`,
  (player) => `💥 **${player}** knew the odds. The odds didn't care.`,
  (player) => `💥 **${player}** — eliminated. The remaining players will not be making eye contact for a while.`,
];

const TENSION_FLAVOR = [
  "🎙️ *The room gets very quiet.*",
  "🎙️ *Nobody is breathing right now.*",
  "🎙️ *The announcer has gone silent. Even they don't want to watch.*",
  "🎙️ *The odds are getting worse. Everyone knows the odds are getting worse.*",
  "🎙️ *At a certain point, luck stops being a factor.*",
  "🎙️ *chat: I can't watch*",
  "🎙️ *chat: bro really doing this*",
  "🎙️ *chat: the odds are not mathing right now*",
];

function pickFrom(arr, ...args) {
  const item = arr[Math.floor(Math.random() * arr.length)];
  return typeof item === "function" ? item(...args) : item;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Slash command definitions ─────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("unfriendly-roulette")
    .setDescription("Unfriendly Roulette — one bullet, six chambers, real consequences 🔫")
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName("play")
        .setDescription("Start a game of Russian Roulette")
        .addUserOption((opt) =>
          opt.setName("player2").setDescription("First opponent").setRequired(true)
        )
        .addUserOption((opt) =>
          opt.setName("player3").setDescription("Second opponent (optional)").setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("stats")
        .setDescription("View roulette stats for a user")
        .addUserOption((opt) =>
          opt.setName("user").setDescription("The user to look up (defaults to you)").setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("leaderboard").setDescription("Show the roulette leaderboard")
    )
    .addSubcommand((sub) =>
      sub.setName("help").setDescription("How Unfriendly Roulette works")
    ),
].map((cmd) => cmd.toJSON());

// ── Register slash commands ───────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log("🔄 Registering slash commands...");
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log("✅ Slash commands registered globally.");
  } catch (err) {
    console.error("❌ Failed to register commands:", err);
  }
}

// ── Game engine ───────────────────────────────────────────────────────────────
function buildGameEmbed({ title, log, players, round, color = 0x8b0000 }) {
  const playerList = players.map(p => `• **${p.name}**`).join("\n");
  const logText    = log.length ? "\n\n" + log.join("\n") : "";

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(`${playerList}${logText}`);
}

async function runGame(channel, players) {
  // Load the cylinder — one bullet in a random chamber
  const bulletChamber = Math.floor(Math.random() * CHAMBERS); // 0-5
  let   pullCount     = 0;
  let   currentIdx    = 0;
  const log           = [];

  const embedTitle = `🔫 Unfriendly Roulette — ${players.map(p => p.name).join(" vs ")}`;

  const gameMsg = await channel.send({
    embeds: [buildGameEmbed({
      title: embedTitle,
      log: ["🎰 The cylinder is loaded. One bullet. Six chambers. Good luck."],
      players,
    })],
  });

  await sleep(PULL_DELAY_MS);

  while (true) {
    const current = players[currentIdx];
    const isBullet = (pullCount === bulletChamber);

    await sleep(PULL_DELAY_MS);

    // Add tension flavor occasionally on later pulls
    if (pullCount >= 3 && Math.random() < 0.4) {
      log.push(pickFrom(TENSION_FLAVOR));
      await gameMsg.edit({
        embeds: [buildGameEmbed({ title: embedTitle, log, players })],
      });
      await sleep(PULL_DELAY_MS);
    }

    if (isBullet) {
      // Loser found
      log.push(pickFrom(LOSER_FLAVOR, current.name));
      await gameMsg.edit({
        embeds: [buildGameEmbed({
          title: `💀 Game Over`,
          log,
          players,
          color: 0xffd700,
        })],
      });

      // Record stats
      const survivors = players.filter(p => p.id !== current.id).map(p => p.id);
      recordResult(survivors, current.id);

      // Timeout the loser
      try {
        await current.member.timeout(
          TIMEOUT_MINUTES * 60 * 1000,
          `Lost an Unfriendly Roulette game`
        );
        await channel.send(`🔇 <@${current.id}> has been muted for ${TIMEOUT_MINUTES} minutes. The odds were never in their favor.`);
      } catch {
        await channel.send(`⚠️ Couldn't time out <@${current.id}> — they may be a mod or above my role.`);
      }

      break;
    } else {
      log.push(pickFrom(SAFE_PULL_FLAVOR, current.name));
      await gameMsg.edit({
        embeds: [buildGameEmbed({ title: embedTitle, log, players })],
      });
    }

    pullCount++;
    currentIdx = (currentIdx + 1) % players.length;
  }
}

// ── Interaction handler ───────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  try {

  // ── Button: accept/decline ────────────────────────────────────────────────
  if (interaction.isButton()) {
    const parts = interaction.customId.split(":");
    if (!parts[0].startsWith("rou_")) return;

    const [action, hostId, ...invitedIds] = parts;
    const gameKey = `${interaction.channel.id}:${hostId}`;
    const game    = activeGames.get(gameKey);

    if (!game) {
      return interaction.reply({ content: "⚠️ This game no longer exists.", ephemeral: true });
    }

    // Only invited players can respond
    if (!invitedIds.includes(interaction.user.id)) {
      return interaction.reply({ content: "⚠️ This invite isn't for you.", ephemeral: true });
    }

    if (action === "rou_decline") {
      // Clean up
      game.players.forEach(id => activePlayers.delete(id));
      activeGames.delete(gameKey);
      await interaction.update({
        content: pickFrom(DECLINE_LINES, interaction.user.id),
        components: [],
      });
      return;
    }

    if (action === "rou_accept") {
      game.accepted.add(interaction.user.id);

      const allAccepted = invitedIds.every(id => game.accepted.has(id));

      if (!allAccepted) {
        // Still waiting on others
        const waiting = invitedIds.filter(id => !game.accepted.has(id));
        await interaction.update({
          content: game.inviteMessage + `\n\n✅ <@${interaction.user.id}> accepted. Still waiting on ${waiting.map(id => `<@${id}>`).join(", ")}.`,
          components: interaction.message.components,
        });
        return;
      }

      // Everyone accepted — start the game
      await interaction.update({
        content: `✅ All players accepted. Starting the game... 🔫`,
        components: [],
      });

      // Fetch full member objects
      const memberObjects = await Promise.all(
        game.players.map(id => interaction.guild.members.fetch(id))
      );

      const players = memberObjects.map(m => ({
        id: m.id,
        name: m.displayName,
        member: m,
      }));

      try {
        await runGame(interaction.channel, players);
      } catch (err) {
        console.error("Game error:", err);
        await interaction.channel.send("💥 Something went wrong mid-game. The cylinder jammed.");
      } finally {
        game.players.forEach(id => activePlayers.delete(id));
        activeGames.delete(gameKey);
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "unfriendly-roulette") return;

  const sub = interaction.options.getSubcommand();

  // ── /unfriendly-roulette help ─────────────────────────────────────────────
  if (sub === "help") {
    return interaction.reply({
      content:
        `## 🔫 Unfriendly Roulette\n` +
        `2-3 players. One bullet. Six chambers. The loser gets timed out.\n\n` +
        `**Commands**\n` +
        `\`/unfriendly-roulette play @user1 [@user2]\` — start a game\n` +
        `\`/unfriendly-roulette stats [@user]\` — view stats\n` +
        `\`/unfriendly-roulette leaderboard\` — server rankings\n` +
        `\`/unfriendly-roulette help\` — show this message\n\n` +
        `**How it works**\n` +
        `> Players take turns pulling the trigger.\n` +
        `> One bullet is loaded into a random chamber out of six.\n` +
        `> Whoever hits the bullet is timed out for ${TIMEOUT_MINUTES} minutes.\n` +
        `> Everyone else is recorded as a survivor.\n\n` +
        `*Part of the **Unfriendly** bot suite.*`,
      ephemeral: true,
    });
  }

  // ── /unfriendly-roulette stats ────────────────────────────────────────────
  if (sub === "stats") {
    const target    = interaction.options.getUser("user") ?? interaction.user;
    const stats     = loadStats();
    const userStats = stats[target.id];

    if (!userStats || (userStats.wins === 0 && userStats.losses === 0)) {
      return interaction.reply({
        content: `📭 No roulette history found for **${target.username}**.`,
        ephemeral: true,
      });
    }

    const member      = await interaction.guild.members.fetch(target.id).catch(() => null);
    const displayName = member?.displayName ?? target.username;
    const total       = userStats.wins + userStats.losses;
    const ratio       = userStats.losses === 0
      ? userStats.wins.toFixed(2)
      : (userStats.wins / userStats.losses).toFixed(2);
    const survivePct  = ((userStats.wins / total) * 100).toFixed(1);

    const statRows = [
      ["✅", "Survived",      String(userStats.wins)],
      ["💀", "Eliminated",    String(userStats.losses)],
      ["📊", "S/E Ratio",     ratio],
      ["🎰", "Total Games",   String(total)],
      ["📈", "Survival Rate", `${survivePct}%`],
    ];
    const labelW   = Math.max(...statRows.map(r => r[1].length));
    const valueW   = Math.max(...statRows.map(r => r[2].length));
    const statLines = statRows.map(([icon, label, value]) =>
      `${icon} \`${label.padEnd(labelW)}\`  \`${value.padStart(valueW)}\``
    ).join("\n");

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x8b0000)
          .setTitle(`🔫 ${displayName} — Roulette Stats`)
          .setDescription(statLines),
      ],
    });
  }

  // ── /unfriendly-roulette leaderboard ─────────────────────────────────────
  if (sub === "leaderboard") {
    const stats = loadStats();

    const top10 = Object.entries(stats)
      .filter(([, u]) => u.wins + u.losses > 0)
      .sort(([, a], [, b]) => {
        if (b.wins !== a.wins) return b.wins - a.wins;
        const ratioA = a.losses === 0 ? a.wins : a.wins / a.losses;
        const ratioB = b.losses === 0 ? b.wins : b.wins / b.losses;
        return ratioB - ratioA;
      })
      .slice(0, 10);

    if (top10.length === 0) {
      return interaction.reply({ content: "📭 No games recorded yet.", ephemeral: true });
    }

    const top10Ids      = top10.map(([id]) => id);
    const fetchedMembers = await interaction.guild.members.fetch({ user: top10Ids }).catch(() => new Map());

    const medals = ["🥇", "🥈", "🥉"];
    const ranked = top10.map(([id, u], idx) => {
      const ratio  = u.losses === 0 ? u.wins.toFixed(2) : (u.wins / u.losses).toFixed(2);
      const member = fetchedMembers.get(id);
      const name   = member?.displayName ?? `Unknown (${id.slice(-4)})`;
      return { medal: medals[idx] ?? `${idx + 1}. `, name, wins: u.wins, losses: u.losses, ratio };
    });

    const nameW  = Math.max(4, ...ranked.map(r => r.name.length));
    const winsW  = Math.max(1, ...ranked.map(r => String(r.wins).length));
    const lossW  = Math.max(1, ...ranked.map(r => String(r.losses).length));
    const ratioW = Math.max(5, ...ranked.map(r => r.ratio.length));

    const header   = `${"RANK".padEnd(6)} ${"NAME".padEnd(nameW)}  ${"S".padStart(winsW)}  ${"E".padStart(lossW)}  ${"RATIO".padStart(ratioW)}`;
    const divider  = "─".repeat(header.length);
    const tableRows = ranked.map((r, i) => {
      const rank = `${r.medal} ${String(i + 1).padEnd(2)}`.slice(0, 6);
      return `${rank} ${r.name.padEnd(nameW)}  ${String(r.wins).padStart(winsW)}  ${String(r.losses).padStart(lossW)}  ${r.ratio.padStart(ratioW)}`;
    });

    const table = "```\n" + header + "\n" + divider + "\n" + tableRows.join("\n") + "\n```";

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xffd700)
          .setTitle("🔫 Unfriendly Roulette — Leaderboard")
          .setDescription(table),
      ],
    });
  }

  // ── /unfriendly-roulette play ─────────────────────────────────────────────
  if (sub === "play") {
    await interaction.deferReply();

    const p2user = interaction.options.getUser("player2");
    const p3user = interaction.options.getUser("player3");
    const p2     = interaction.options.getMember("player2");
    const p3     = interaction.options.getMember("player3");

    // Validation
    const allUsers   = [interaction.user, p2user, p3user].filter(Boolean);
    const allMembers = [interaction.member, p2, p3].filter(Boolean);
    const invited    = [p2user, p3user].filter(Boolean);

    if (allUsers.some(u => u.bot)) {
      return interaction.editReply({ content: "❌ Bots don't play roulette. They have too much to live for." });
    }
    if (new Set(allUsers.map(u => u.id)).size !== allUsers.length) {
      return interaction.editReply({ content: "❌ You can't invite the same person twice." });
    }
    if (allUsers.some(u => u.id === interaction.user.id && u !== interaction.user)) {
      return interaction.editReply({ content: "❌ You can't invite yourself." });
    }
    if (allMembers.some(m => m.communicationDisabledUntil && m.communicationDisabledUntil > new Date())) {
      return interaction.editReply({ content: "❌ One of the invited players is currently timed out." });
    }
    if (allUsers.some(u => activePlayers.has(u.id))) {
      return interaction.editReply({ content: "⚠️ One of the players is already in a game." });
    }

    const botMember = interaction.guild.members.me;
    if (!botMember.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
      return interaction.editReply({ content: "⚠️ I need **Moderate Members** permission to time out the loser." });
    }

    // Register all players as active
    allUsers.forEach(u => activePlayers.add(u.id));

    const gameKey     = `${interaction.channel.id}:${interaction.user.id}`;
    const invitedIds  = invited.map(u => u.id);
    const allIds      = allUsers.map(u => u.id);
    const playerMentions = invited.map(u => `<@${u.id}>`).join(" and ");
    const inviteMsg   = pickFrom(CHALLENGE_TAUNTS, interaction.user.id, playerMentions);

    activeGames.set(gameKey, {
      players:       allIds,
      accepted:      new Set([interaction.user.id]),
      inviteMessage: inviteMsg,
    });

    // Build accept/decline buttons — one per invited player
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rou_accept:${interaction.user.id}:${invitedIds.join(":")}`)
        .setLabel("Accept")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`rou_decline:${interaction.user.id}:${invitedIds.join(":")}`)
        .setLabel("Decline")
        .setStyle(ButtonStyle.Danger)
    );

    await interaction.editReply({
      content: `${inviteMsg}\n\n${invited.map(u => `<@${u.id}>`).join(" and ")}, do you accept?`,
      components: [row],
    });

    // Auto-expire after 60s
    setTimeout(async () => {
      if (!activeGames.has(gameKey)) return;
      allIds.forEach(id => activePlayers.delete(id));
      activeGames.delete(gameKey);
      try {
        await interaction.editReply({
          content: pickFrom(TIMEOUT_LINES, interaction.user.id, invitedIds[0]),
          components: [],
        });
      } catch { /* expired */ }
    }, INVITE_TIMEOUT_MS);
  }

  } catch (err) {
    console.error("Unhandled interaction error:", err);
    console.error("  Command:", interaction.commandName ?? interaction.customId ?? "unknown");
    console.error("  User:   ", interaction.user?.tag ?? "unknown");
    console.error("  Guild:  ", interaction.guild?.name ?? "null — bot may not be properly installed");
    try {
      const msg = "💥 Something went wrong. If this keeps happening, let a server admin know.";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: msg });
      } else {
        await interaction.reply({ content: msg, ephemeral: true });
      }
    } catch { /* interaction may have already expired */ }
  }
});

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`✅ ${client.user.tag} is online.`);
  client.user.setActivity("Unfriendly Roulette", { type: ActivityType.Playing });
  await registerCommands();
});

client.login(process.env.DISCORD_TOKEN);
