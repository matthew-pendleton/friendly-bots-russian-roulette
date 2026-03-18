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

const dotenvResult = require("dotenv").config({ path: path.join(__dirname, ".env") });
if (dotenvResult.error) {
  console.warn("⚠️ No .env loaded (or failed to parse).");
  console.warn("   Expected at:", path.join(__dirname, ".env"));
}

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error("❌ Missing required environment variables.");
  console.error("   Required: DISCORD_TOKEN, CLIENT_ID");
  console.error("   Optional: GUILD_ID (register commands instantly to one server)");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ── Active game tracking ──────────────────────────────────────────────────────
const activeGames   = new Map(); // gameKey (channelId:hostId) → game state
const activePlayers = new Set(); // userId → in a game

// ── Config ────────────────────────────────────────────────────────────────────
const TIMEOUT_MINUTES      = 5;
const INVITE_TIMEOUT_MS    = 60000;
const TURN_TIMEOUT_MS      = 30000;
const PULL_DELAY_MS        = 1200;
const CHAMBERS             = 6;
const ROUND_EMOJIS        = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"];
const STATS_FILE           = path.join(__dirname, "stats.json");

/** Pick n distinct chamber indices (0..CHAMBERS-1). */
function pickRandomChambers(n) {
  const indices = [...Array(CHAMBERS).keys()];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (indices.length - i));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, n);
}

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
  (c, players) => `🔫 <@${c}> has loaded the cylinder and is inviting ${players} to play. Nobody has to do this.`,
  (c, players) => `🎰 <@${c}> has proposed an unfriendly game of Russian Roulette to ${players}. The word "unfriendly" is doing a lot of work here.`,
  (c, players) => `🕯️ <@${c}> dimmed the lights, poured something they shouldn't have, and challenged ${players} to a round.`,
  (c, players) => `🩸 <@${c}> has decided that ${players} should play a game. The game involves one bullet and poor decision-making.`,
];

const DECLINE_LINES = [
  (d) => `🐔 <@${d}> looked at the gun, looked at the table, and left the room.`,
  (d) => `📵 <@${d}> declined. Smart. Cowardly.`,
  (d) => `🧘 <@${d}> said they're in a really good headspace right now and a bullet would disrupt that.`,
  (d) => `🍵 <@${d}> said they just made tea and the timing really doesn't work for them right now.`,
];

const TIMEOUT_LINES = [
  (c, d) => `⏱️ <@${d}> didn't respond to <@${c}>'s challenge.`,
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
  (player) => `💥 **${player}** hits the bullet.`,
  (player) => `💥 **${player}** pulls the trigger — empty chambers are out of luck.`,
  (player) => `💥 **${player}** knew the odds. This one wasn't kind.`,
  (player) => `💥 **${player}** is eliminated by a single bullet.`,
];

const FORFEIT_FLAVOR = [
  (player) => `⏱️ **${player}** didn't pull in time. Forfeit.`,
  (player) => `⏳ **${player}** hesitated too long and is eliminated.`,
];

const TENSION_FLAVOR = [
  "🎙️ *The room gets very quiet.*",
  "🎙️ *The announcer has gone silent. Even they don't want to watch.*",
  "🎙️ *The odds are getting worse. Everyone knows the odds are getting worse.*",
  "🎙️ *At a certain point, luck stops being a factor.*",
];

function pickFrom(arr, ...args) {
  const item = arr[Math.floor(Math.random() * arr.length)];
  return typeof item === "function" ? item(...args) : item;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildPullRow({ channelId, hostId, turn, enabled = true, requiredPlayerName }) {
  const label = requiredPlayerName
    ? `Pull trigger: ${requiredPlayerName}`
    : "Pull trigger";

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rou_pull:${channelId}:${hostId}:${turn}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!enabled)
  );
}

// ── Slash command definitions ─────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("unfriendly-roulette")
    .setDescription("Unfriendly Roulette — one or two bullets, six chambers, real consequences 🔫")
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
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    console.log("🔄 Registering slash commands...");
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log(`✅ Slash commands registered to guild ${GUILD_ID}.`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("✅ Slash commands registered globally.");
      console.log("   (Global commands can take a while to appear. Set GUILD_ID to register instantly.)");
    }
  } catch (err) {
    console.error("❌ Failed to register commands:", err);
  }
}

// ── Game engine ───────────────────────────────────────────────────────────────
function buildGameEmbed({ title, log, players, currentPlayerId, color = 0x8b0000 }) {
  const playersInline = players.map(p => `**${p.name}**`).join(" · ");
  const logBlock       = log.length
    ? log.map(line => `> ${line}`).join("\n")
    : "> (waiting for first pull)";
  const turnFooter     = currentPlayerId
    ? `\n\n## <@${currentPlayerId}>'s turn`
    : "";

  const description = `### ${playersInline}\n\n${logBlock}${turnFooter}`;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description);
}

function cleanupGame(gameKey) {
  const game = activeGames.get(gameKey);
  if (!game) return;
  if (game.turnTimer) clearTimeout(game.turnTimer);
  game.players.forEach(p => activePlayers.delete(p.id));
  activeGames.delete(gameKey);
}

async function finishGame({ gameKey, channel, players, loser, canTimeout, log, gameMsg }) {
  if (!activeGames.has(gameKey)) return;
  const winners = players.filter(p => p.id !== loser.id);
  const winnerNames = winners.map(p => p.name);
  const winnerText = winnerNames.length === 1
    ? `${winnerNames[0]} Wins`
    : `Winners: ${winnerNames.join(", ")}`;

  // Record stats
  const survivors = winners.map(p => p.id);
  recordResult(survivors, loser.id);

  // Disable buttons
  await gameMsg.edit({
    embeds: [buildGameEmbed({
      title: `Game Over - ${winnerText}`,
      log,
      players,
      color: 0xffd700,
    })],
    components: [],
  }).catch(() => {});

  if (canTimeout) {
    try {
      await loser.member.timeout(
        TIMEOUT_MINUTES * 60 * 1000,
        `Lost an Unfriendly Roulette game`
      );
      await channel.send(`🔇 <@${loser.id}> has been muted for ${TIMEOUT_MINUTES} minutes. The odds were never in their favor.`);
    } catch {
      await channel.send(`⚠️ Couldn't time out <@${loser.id}> — they may be a mod or above my role.`);
    }
  } else {
    await channel.send(`⚠️ I don't have Moderate Members permission, so <@${loser.id}> won't be timed out this round.`);
  }

  cleanupGame(gameKey);
}

async function startTurn(gameKey) {
  const game = activeGames.get(gameKey);
  if (!game) return;

  const current = game.players[game.currentIdx];
  const roundNum = game.turn + 1;
  const roundEmoji = ROUND_EMOJIS[roundNum - 1] ?? `${roundNum}`;

  // Add tension flavor occasionally on later pulls
  if (game.pullCount >= 3 && Math.random() < 0.4) {
    game.log.push(`${roundEmoji} Commentary: ${pickFrom(TENSION_FLAVOR)}`);
  }

  const embeds = [buildGameEmbed({
    title: game.embedTitle,
    log: [...game.log],
    players: game.players,
    currentPlayerId: current.id,
  })];

  await game.gameMsg.edit({
    embeds,
    components: [buildPullRow({
      channelId: game.channelId,
      hostId: game.hostId,
      turn: game.turn,
      enabled: true,
      requiredPlayerName: current.name,
    })],
  }).catch(() => {});

  if (game.turnTimer) clearTimeout(game.turnTimer);
  const forfeitingTurn = game.turn;
  const forfeitingIdx = game.currentIdx;
  const forfeitingRoundNum = roundNum;
  game.turnTimer = setTimeout(async () => {
    const g = activeGames.get(gameKey);
    if (!g || g.turn !== forfeitingTurn) return;
    const forfeiter = g.players[forfeitingIdx];
    const forfeitEmoji = ROUND_EMOJIS[forfeitingRoundNum - 1] ?? `${forfeitingRoundNum}`;
    g.log.push(`${forfeitEmoji} **${forfeiter.name}** forfeits (no pull in time) — eliminated.`);

    // Timeout forfeiter if we have permission (same for 2- and 3-player)
    if (g.canTimeout) {
      try {
        await forfeiter.member.timeout(TIMEOUT_MINUTES * 60 * 1000, `Lost an Unfriendly Roulette game (forfeit)`);
        await g.channel.send(`🔇 <@${forfeiter.id}> has been muted for ${TIMEOUT_MINUTES} minutes (forfeit).`);
      } catch {
        await g.channel.send(`⚠️ Couldn't time out <@${forfeiter.id}> — they may be a mod or above my role.`);
      }
    } else {
      await g.channel.send(`⚠️ I don't have Moderate Members permission, so <@${forfeiter.id}> won't be timed out.`);
    }

    activePlayers.delete(forfeiter.id);

    if (g.players.length === 2) {
      // 2-player game: forfeit = game over (finishGame does recordResult + embed + cleanup)
      await finishGame({
        gameKey,
        channel: g.channel,
        players: g.players,
        loser: forfeiter,
        canTimeout: g.canTimeout,
        log: g.log,
        gameMsg: g.gameMsg,
      });
      return;
    }

    // 3-player game: record elimination and continue with 2 players (same chamber / pull count)
    const survivors = g.players.filter(p => p.id !== forfeiter.id).map(p => p.id);
    recordResult(survivors, forfeiter.id);
    const newPlayers = g.players.filter(p => p.id !== forfeiter.id);
    const nextOldIdx = (forfeitingIdx + 1) % g.players.length;
    const newCurrentIdx = nextOldIdx > forfeitingIdx ? nextOldIdx - 1 : nextOldIdx;

    g.players = newPlayers;
    g.currentIdx = newCurrentIdx;
    await startTurn(gameKey);
  }, TURN_TIMEOUT_MS);
}

async function handlePull({ interaction, gameKey, turn }) {
  const game = activeGames.get(gameKey);
  if (!game) {
    return interaction.reply({ content: "⚠️ This game no longer exists.", ephemeral: true }).catch(() => {});
  }

  if (turn !== game.turn) {
    return interaction.reply({ content: "⚠️ This turn has already moved on.", ephemeral: true }).catch(() => {});
  }

  const current = game.players[game.currentIdx];
  if (interaction.user.id !== current.id) {
    return interaction.reply({ content: `⚠️ It's <@${current.id}>'s turn.`, ephemeral: true }).catch(() => {});
  }

  if (game.turnTimer) clearTimeout(game.turnTimer);

  // Prevent double clicks while we resolve
  await interaction.update({
    components: [buildPullRow({
      channelId: game.channelId,
      hostId: game.hostId,
      turn: game.turn,
      enabled: false,
      requiredPlayerName: current.name,
    })],
  }).catch(() => {});

  await sleep(PULL_DELAY_MS);

  const isBullet = game.bulletChambers.includes(game.pullCount);
  if (isBullet) {
    const roundNum = game.turn + 1;
    const roundEmoji = ROUND_EMOJIS[roundNum - 1] ?? `${roundNum}`;
    game.log.push(`${roundEmoji} 💥 BANG! **${current.name}** is eliminated.`);
    await finishGame({
      gameKey,
      channel: game.channel,
      players: game.players,
      loser: current,
      canTimeout: game.canTimeout,
      log: game.log,
      gameMsg: game.gameMsg,
    });
    return;
  }

  const safeRoundNum = game.turn + 1;
  const safeRoundEmoji = ROUND_EMOJIS[safeRoundNum - 1] ?? `${safeRoundNum}`;
  game.log.push(`${safeRoundEmoji} **${current.name}** pulls — \`safe\`.`);
  game.pullCount += 1;
  game.currentIdx = (game.currentIdx + 1) % game.players.length;
  game.turn += 1;
  await startTurn(gameKey);
}

// ── Interaction handler ───────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  try {

  // ── Button interactions ───────────────────────────────────────────────────
  if (interaction.isButton()) {
    const parts = interaction.customId.split(":");
    if (!parts[0].startsWith("rou_")) return;

    const action = parts[0];

    if (action === "rou_pull") {
      const [, channelId, hostId, turnStr] = parts;
      const gameKey = `${channelId}:${hostId}`;
      const turn = Number(turnStr);
      if (!Number.isFinite(turn)) {
        return interaction.reply({ content: "⚠️ Invalid action.", ephemeral: true });
      }
      return handlePull({ interaction, gameKey, turn });
    }

    const [, hostId, ...invitedIds] = parts;
    const gameKey = `${interaction.channel.id}:${hostId}`;
    const game    = activeGames.get(gameKey);

    if (!game) {
      return interaction.reply({ content: "⚠️ This game no longer exists.", ephemeral: true });
    }

    if (game.phase && game.phase !== "invite") {
      return interaction.reply({ content: "⚠️ This invite has already been used.", ephemeral: true });
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
        const channelId = interaction.channel.id;
        const hostIdStr = String(hostId);
        const botMember = interaction.guild.members.me;
        const canTimeout = botMember?.permissions?.has(PermissionsBitField.Flags.ModerateMembers) ?? false;

        const embedTitle = "🔫 Unfriendly Roulette";
        const gameMsg = await interaction.channel.send({
          embeds: [buildGameEmbed({
            title: embedTitle,
            log: [],
            players,
          })],
          components: [buildPullRow({ channelId, hostId: hostIdStr, turn: 0, enabled: true })],
        });

        activeGames.set(gameKey, {
          phase: "game",
          channel: interaction.channel,
          channelId,
          hostId: hostIdStr,
          players,
          embedTitle,
          gameMsg,
          canTimeout,
          bulletChambers: pickRandomChambers(players.length === 3 ? 2 : 1),
          pullCount: 0,
          currentIdx: 0,
          turn: 0,
          log: [],
          turnTimer: null,
        });

        await startTurn(gameKey);
      } catch (err) {
        console.error("Game error:", err);
        await interaction.channel.send("💥 Something went wrong mid-game. The cylinder jammed.");
      } finally {
        // game cleanup handled by finishGame/cleanupGame
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
        `2-3 players. One bullet (2 players) or two bullets (3 players). Six chambers.\n` +
        `Each turn is a button press — if you don't pull within 30 seconds, you forfeit.\n` +
        `The loser gets timed out if I have Moderate Members permission.\n\n` +
        `**Commands**\n` +
        `\`/unfriendly-roulette play @user1 [@user2]\` — start a game\n` +
        `\`/unfriendly-roulette stats [@user]\` — view stats\n` +
        `\`/unfriendly-roulette leaderboard\` — server rankings\n` +
        `\`/unfriendly-roulette help\` — show this message\n\n` +
        `**How it works**\n` +
        `> Players take turns pulling the trigger.\n` +
        `> Bullets are loaded into random chambers (1 for 2 players, 2 for 3 players).\n` +
        `> Whoever hits the bullet is timed out for ${TIMEOUT_MINUTES} minutes (only if I have Moderate Members).\n` +
        `> If a player doesn't pull within 30 seconds, they forfeit (game over in 2-player; in 3-player they're eliminated and the game continues).\n` +
        `> Everyone else is recorded as a survivor.\n\n` +
        `*Part of the **Unfriendly** bot suite by Aaykith.*`,
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
    const canTimeout = botMember?.permissions?.has(PermissionsBitField.Flags.ModerateMembers) ?? false;
    const permissionNote = canTimeout
      ? ""
      : "\n\n⚠️ I don't have Moderate Members permission, so the loser won't be timed out.";

    // Register all players as active
    allUsers.forEach(u => activePlayers.add(u.id));

    const gameKey     = `${interaction.channel.id}:${interaction.user.id}`;
    const invitedIds  = invited.map(u => u.id);
    const allIds      = allUsers.map(u => u.id);
    const playerMentions = invited.map(u => `<@${u.id}>`).join(" and ");
    const inviteMsg   = pickFrom(CHALLENGE_TAUNTS, interaction.user.id, playerMentions);

    activeGames.set(gameKey, {
      phase:         "invite",
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
      content: `${inviteMsg}\n\n${invited.map(u => `<@${u.id}>`).join(" and ")}, do you accept?${permissionNote}`,
      components: [row],
    });

    // Auto-expire after 60s
    setTimeout(async () => {
      const g = activeGames.get(gameKey);
      if (!g || g.phase !== "invite") return;
      const whoDidntRespond = invitedIds.filter(id => !g.accepted.has(id));
      allIds.forEach(id => activePlayers.delete(id));
      activeGames.delete(gameKey);
      try {
        const challenger = interaction.user.id;
        const msg = whoDidntRespond.length === 0
          ? pickFrom(TIMEOUT_LINES, challenger, invitedIds[0])
          : whoDidntRespond.length === 1
            ? pickFrom(TIMEOUT_LINES, challenger, whoDidntRespond[0])
            : `⏱️ ${whoDidntRespond.map(id => `<@${id}>`).join(" and ")} didn't respond to <@${challenger}>'s challenge.`;
        await interaction.editReply({
          content: msg,
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

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("❌ Failed to login to Discord. Check DISCORD_TOKEN.", err);
  process.exit(1);
});
