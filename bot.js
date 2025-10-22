const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require('discord.js');
const { joinVoiceChannel } = require('@discordjs/voice');
const { Riffy } = require('riffy');
require('dotenv').config();
const http = require('http');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// Riffy setup
let riffy;
const lavalinkConfig = {
    name: process.env.LAVALINK_NAME || 'lavalink',
    password: process.env.LAVALINK_PASSWORD,
    host: process.env.LAVALINK_HOST,
    port: Number(process.env.LAVALINK_PORT || 2333),
    secure: process.env.LAVALINK_SECURE === 'true'
};

riffy = new Riffy(client, [lavalinkConfig], {
    send: (payload) => {
        const guild = client.guilds.cache.get(payload.d.guild_id);
        if (guild) guild.shard.send(payload);
    },
    defaultSearchPlatform: "ytsearch",
    restVersion: "v4",
});

// Riffy events
riffy.on('nodeConnect', (node) => console.log(`Lavalink node connected: ${node.name}`));
riffy.on('nodeError', (node, error) => console.log(`Lavalink node error: ${error.message}`));
riffy.on('trackStart', async (player, track) => {
    console.log(`Track started: ${track.info.title}`);
    await updateMusicPanel(player);
});
riffy.on('trackEnd', async (player, track) => {
    console.log(`Track ended: ${track.info.title}`);
    await updateMusicPanel(player);
    if (stayConnectedGuilds.get(player.guildId)) {
        player.playing = false;
        player.paused = false;
        await updateMusicPanel(player);
    }
});
riffy.on('queueEnd', async (player) => {
    await updateMusicPanel(player);
    if (stayConnectedGuilds.get(player.guildId)) {
        player.playing = false;
        player.paused = false;
        await updateMusicPanel(player);
    } else {
        player.destroy();
    }
});

// Auto-reconnect configuration
const AUTO_RECONNECT_CHANNEL_ID = '1430368066130149456';
const RECONNECT_DELAY = 15000; // 15 seconds

// Auto-reconnect functionality
const autoReconnectToChannel = async (guildId) => {
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;

        const channel = guild.channels.cache.get(AUTO_RECONNECT_CHANNEL_ID);
        if (!channel) return;

        // Check if bot is already in the channel
        const botMember = guild.members.cache.get(client.user.id);
        if (botMember?.voice?.channelId === AUTO_RECONNECT_CHANNEL_ID) {
            return; // Already in the target channel
        }

        console.log(`Auto-reconnecting to channel ${AUTO_RECONNECT_CHANNEL_ID} in guild ${guildId}`);
        
        // Create or get existing player
        let player = riffy.players.get(guildId);
        if (!player) {
            player = riffy.createConnection({
                guildId: guildId,
                voiceChannel: AUTO_RECONNECT_CHANNEL_ID,
                textChannel: AUTO_RECONNECT_CHANNEL_ID,
                deaf: true
            });
        } else {
            // Update existing player to reconnect to the channel
            player.voiceChannel = AUTO_RECONNECT_CHANNEL_ID;
            player.textChannel = AUTO_RECONNECT_CHANNEL_ID;
        }

        // Enable stay connected mode
        stayConnectedGuilds.set(guildId, true);
        
    } catch (error) {
        console.error('Auto-reconnect error:', error);
    }
};

// Track disconnections and schedule reconnects
const scheduleReconnect = (guildId) => {
    setTimeout(() => {
        autoReconnectToChannel(guildId);
    }, RECONNECT_DELAY);
};

// Processing flag to prevent spam
let processing = new Map();
const musicPanels = new Map();
const guildChannelConfig = new Map();
const stayConnectedGuilds = new Map();

const formatDuration = (ms) => {
    if (typeof ms !== 'number' || Number.isNaN(ms)) return '0:00';
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const buildMusicPanel = (player) => {
    const current = player.current;
    const queuePreview = player.queue.slice(0, 5);
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Music Player');
    if (current?.info) {
        embed.setDescription(`**${current.info.title}**\n${current.info.author}\n\`${formatDuration(current.info.length)}\``);
        if (current.info.artworkUrl || current.info.thumbnail) {
            embed.setImage(current.info.artworkUrl || current.info.thumbnail);
        }
    } else {
        embed.setDescription('Nothing is playing.');
    }
    embed.addFields(
        { name: 'Status', value: player.paused ? 'Paused' : player.playing ? 'Playing' : 'Idle', inline: true },
        { name: 'Volume', value: `${player.volume}%`, inline: true },
        {
            name: 'Queue',
            value: queuePreview.length ? queuePreview.map((track, index) => `${index + 1}. ${track.info?.title ?? 'Unknown track'}`).join('\n') : 'Queue empty',
            inline: false,
        }
    );
    const controls = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('music_pause').setLabel('Pause').setStyle(ButtonStyle.Secondary).setDisabled(player.paused || !player.playing),
        new ButtonBuilder().setCustomId('music_resume').setLabel('Resume').setStyle(ButtonStyle.Success).setDisabled(!player.paused),
        new ButtonBuilder().setCustomId('music_skip').setLabel('Skip').setStyle(ButtonStyle.Primary).setDisabled(!player.playing),
        new ButtonBuilder().setCustomId('music_leave').setLabel('Leave').setStyle(ButtonStyle.Danger)
    );
    return { embeds: [embed], components: [controls] };
};

const updateMusicPanel = async (player) => {
    const channelId = player.textChannel;
    if (!channelId) return;
    const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;
    const payload = buildMusicPanel(player);
    const stored = musicPanels.get(player.guildId);
    if (stored) {
        const message = await channel.messages.fetch(stored.messageId).catch(() => null);
        if (message) {
            await message.edit(payload).catch(() => null);
            return;
        }
        musicPanels.delete(player.guildId);
    }
    const sent = await channel.send(payload).catch(() => null);
    if (sent) {
        musicPanels.set(player.guildId, { channelId: channel.id, messageId: sent.id });
        if (guildChannelConfig.get(player.guildId) === channel.id) {
            sent.pin().catch(() => null);
        }
    }
};

const clearMusicPanel = async (guildId) => {
    const stored = musicPanels.get(guildId);
    if (!stored) return;
    const channel = client.channels.cache.get(stored.channelId) || await client.channels.fetch(stored.channelId).catch(() => null);
    if (channel) {
        const message = await channel.messages.fetch(stored.messageId).catch(() => null);
        if (message) {
            await message.delete().catch(() => null);
        }
    }
    musicPanels.delete(guildId);
};

const TOKEN = process.env.BOT_TOKEN;

// Raw event for Lavalink
client.on('raw', (d) => {
    if (d.t === "VOICE_STATE_UPDATE" || d.t === "VOICE_SERVER_UPDATE") {
        riffy.updateVoiceState(d);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton() || !interaction.guildId) return;
    const player = riffy.players.get(interaction.guildId);
    if (!player) {
        await interaction.reply({ content: 'Nothing is playing.', ephemeral: true }).catch(() => null);
        return;
    }
    await interaction.deferUpdate().catch(() => null);
    if (interaction.customId === 'music_pause') {
        if (!player.paused && player.playing) {
            player.pause(true);
        }
    } else if (interaction.customId === 'music_resume') {
        if (player.paused) {
            player.pause(false);
        }
    } else if (interaction.customId === 'music_skip') {
        if (player.playing || player.paused) {
            player.stop();
            if (player.queue.length > 0) {
                player.play();
            } else {
                player.playing = false;
            }
        }
    } else if (interaction.customId === 'music_leave') {
        player.destroy();
        await clearMusicPanel(interaction.guildId);
    }
    await updateMusicPanel(player);
});

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    // Init Riffy
    riffy.init(client.user.id);
    console.log('Riffy initialized');
    
    // Auto-connect to the specified channel on startup
    const guilds = client.guilds.cache;
    for (const [guildId, guild] of guilds) {
        const channel = guild.channels.cache.get(AUTO_RECONNECT_CHANNEL_ID);
        if (channel) {
            console.log(`Found target channel in guild ${guildId}, connecting...`);
            await autoReconnectToChannel(guildId);
            break; // Only connect to the first guild that has the target channel
        }
    }
});

// Listen for voice state updates to detect disconnections
client.on('voiceStateUpdate', async (oldState, newState) => {
    // Check if it's the bot's voice state that changed
    if (oldState.member.id !== client.user.id) return;
    
    // If bot was in a voice channel and now isn't, schedule reconnect
    if (oldState.channelId && !newState.channelId) {
        console.log(`Bot disconnected from voice channel ${oldState.channelId} in guild ${oldState.guild.id}`);
        scheduleReconnect(oldState.guild.id);
    }
});

// Listen for player disconnections
riffy.on('playerDisconnect', (player) => {
    console.log(`Player disconnected from guild ${player.guildId}`);
    scheduleReconnect(player.guildId);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const guildId = message.guild.id;
    const configuredChannelId = guildChannelConfig.get(guildId);

    if (message.content === '!set_tammy') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
            return message.reply('You need Manage Server permission to set the music channel.').then((msg) => {
                setTimeout(() => msg.delete().catch(() => null), 5000);
            }).catch(() => null);
        }

        guildChannelConfig.set(guildId, message.channel.id);
        message.reply('This channel is now the official music channel. Type song names or links without a prefix.').then((msg) => {
            setTimeout(() => msg.delete().catch(() => null), 5000);
        }).catch(() => null);
        setTimeout(() => {
            message.delete().catch(() => null);
        }, 5000);
        return;
    }

    const isOfficialChannel = configuredChannelId && message.channel.id === configuredChannelId;
    const isPlayCommand = message.content.startsWith('!play ');

    if (message.content === '!247') {
        if (!message.member.voice.channelId) {
            return message.reply('You must be in a voice channel to enable 24/7 mode.').then((msg) => {
                setTimeout(() => msg.delete().catch(() => null), 5000);
            }).catch(() => null);
        }
        const player = riffy.createConnection({
            guildId: guildId,
            voiceChannel: message.member.voice.channelId,
            textChannel: message.channel.id,
            deaf: true
        });
        stayConnectedGuilds.set(guildId, true);
        message.reply('24/7 mode enabled. I will stay in this voice channel.').then((msg) => {
            setTimeout(() => msg.delete().catch(() => null), 5000);
        }).catch(() => null);
        setTimeout(() => {
            message.delete().catch(() => null);
        }, 5000);
        await updateMusicPanel(player);
        return;
    }

    if (isPlayCommand || isOfficialChannel) {
        const query = isPlayCommand ? message.content.slice(6).trim() : message.content.trim();
        if (!query) {
            if (isOfficialChannel) {
                setTimeout(() => message.delete().catch(() => null), 5000);
            }
            return message.reply('Please provide a song to play.').then((msg) => {
                setTimeout(() => msg.delete().catch(() => null), 5000);
            }).catch(() => null);
        }
        const guildId = message.guild.id;
        if (processing.get(guildId)) {
            return message.reply('Already processing a play command, please wait.');
        }

        processing.set(guildId, true);

        try {
            if (!message.member.voice.channelId) {
                processing.delete(guildId);
                return message.reply('You must be in a voice channel to play music.');
            }

            const isUrl = query.startsWith('http') || query.startsWith('https');
            const resolveOptions = { query: query, requester: message.author };
            // For URLs, Lavalink loads directly without source

            const res = await riffy.resolve(resolveOptions);
            console.log(`Search result: ${res.loadType}`);
            console.log(`Tracks found: ${res.tracks.length}`);
            for (let i = 0; i < Math.min(5, res.tracks.length); i++) {
                console.log(`Track ${i}: ${res.tracks[i].info.title}`);
            }

            if (res.loadType === 'error') {
                processing.delete(guildId);
                return message.reply('An error occurred while searching.');
            }
            if (res.loadType === 'empty') {
                processing.delete(guildId);
                return message.reply('No results found.');
            }

            const player = riffy.createConnection({
                guildId: message.guild.id,
                voiceChannel: message.member.voice.channelId,
                textChannel: message.channel.id,
                deaf: true
            });
            if (!isPlayCommand && !stayConnectedGuilds.get(guildId)) {
                stayConnectedGuilds.set(guildId, false);
            }

            player.queue.add(res.tracks[0]);
            const replyMessage = await message.reply(`Added to queue: **${res.tracks[0].info.title}**`);
            console.log(`Added to queue: ${res.tracks[0].info.title}`);
            await updateMusicPanel(player);
            setTimeout(() => {
                message.delete().catch(() => null);
            }, 5000);
            if (replyMessage) {
                setTimeout(() => {
                    replyMessage.delete().catch(() => null);
                }, 5000);
            }

            if (!player.playing) {
                player.play();
                console.log('Started playing');
                await updateMusicPanel(player);
            }

            processing.delete(guildId);
        } catch (error) {
            console.error('Play command error:', error);
            message.reply('An error occurred while playing music.');
            processing.delete(guildId);
        }
    }
});

if (!TOKEN) {
    console.error('BOT_TOKEN is not set.');
    process.exit(1);
}

if (!lavalinkConfig.host || !lavalinkConfig.password) {
    console.error('Lavalink configuration is incomplete. Please set LAVALINK_HOST, LAVALINK_PORT, LAVALINK_PASSWORD.');
    process.exit(1);
}

client.login(TOKEN);

const port = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running');
}).listen(port, () => {
    console.log(`HTTP server listening on port ${port}`);
});
