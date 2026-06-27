require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const play = require('play-dl');
const ytSearch = require('yt-search');
const msgs = require('./messages.json');
const storage = require('./lib/storage');

const COLORS = {
    info: '#3498DB',
    error: '#E74C3C',
    rules: '#5865F2',
    success: '#2ECC71',
    warn: '#F1C40F',
    mute: '#E67E22',
    ban: '#992D22'
};

const DEFAULT_MUTE_DURATION = 10 * 60 * 1000;
const MAX_MUTE_DURATION = 28 * 24 * 60 * 60 * 1000;
const prefix = '?';
const warnsDatabase = new Map();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// store last search results per guild: guildId -> [{title, url}] 
const searchResults = new Map();

const createEmbed = ({ color = COLORS.info, title, description }) => {
    const embed = new EmbedBuilder().setColor(color);
    if (title) embed.setTitle(title);
    if (description) embed.setDescription(description);
    return embed;
};

async function searchYouTube(query) {
    try {
        const result = await ytSearch(query);
        return (result && result.videos ? result.videos : []).slice(0, 5);
    } catch (err) {
        console.error('YouTube search error', err);
        return [];
    }
}

// Guild audio player and queue management
const guildPlayers = new Map(); // guildId -> { connection, player, queue:[], index, looping (bool), volume: number, resource }

function createGuildState(guildId) {
    const state = {
        connection: null,
        player: createAudioPlayer(),
        queue: [],
        index: 0,
        looping: false,
        volume: 0.5,
        resource: null
    };

    state.player.on(AudioPlayerStatus.Idle, async () => {
        try {
            if (state.looping) {
                // replay current
                await playCurrent(guildId);
                return;
            }

            state.index++;
            if (state.index < state.queue.length) {
                await playCurrent(guildId);
            } else {
                // queue finished
                try { state.connection.destroy(); } catch (e) {}
                guildPlayers.delete(guildId);
            }
        } catch (err) {
            console.error('player idle handler error', err);
        }
    });

    return state;
}

async function ensureConnection(member) {
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) return null;
    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator
    });
    return connection;
}

async function playCurrent(guildId) {
    const state = guildPlayers.get(guildId);
    if (!state) return;
    const track = state.queue[state.index];
    if (!track) return;

    const stream = await play.stream(track.url).catch(() => null);
    if (!stream) {
        state.player.stop(true);
        return;
    }

    const resource = createAudioResource(stream.stream, { inputType: stream.type, inlineVolume: true });
    resource.volume.setVolume(state.volume);
    state.resource = resource;
    state.player.play(resource);
    try { state.connection.subscribe(state.player); } catch (e) {}
}

async function enqueueTrack(member, track, textChannel) {
    if (!member.voice.channel) return textChannel.send('Войдите в голосовой канал 먼저.');
    const guildId = member.guild.id;
    let state = guildPlayers.get(guildId);
    if (!state) {
        state = createGuildState(guildId);
        const conn = await ensureConnection(member);
        if (!conn) return textChannel.send('Не удалось подключиться к голосовому каналу.');
        state.connection = conn;
        guildPlayers.set(guildId, state);
    }

    state.queue.push(track);
    const pos = state.queue.length;
    textChannel.send(`Добавлено в очередь: ${track.title} (позиция ${pos})`);

    // if player is idle and this is the only track, start playing
    if (state.player.state.status !== 'playing') {
        state.index = state.queue.length - 1;
        await playCurrent(guildId);
        return textChannel.send(`Воспроизвожу: ${track.title}`);
    }
}

function pauseGuild(guildId, textChannel) {
    const state = guildPlayers.get(guildId);
    if (!state) return textChannel.send('Нет активного воспроизведения.');
    state.player.pause();
    return textChannel.send('Пауза.');
}

function resumeGuild(guildId, textChannel) {
    const state = guildPlayers.get(guildId);
    if (!state) return textChannel.send('Нет активного воспроизведения.');
    state.player.unpause();
    return textChannel.send('Возобновлено.');
}

function skipGuild(guildId, textChannel) {
    const state = guildPlayers.get(guildId);
    if (!state) return textChannel.send('Нет активного воспроизведения.');
    state.player.stop(true);
    return textChannel.send('Пропускаю.');
}

function prevGuild(guildId, textChannel) {
    const state = guildPlayers.get(guildId);
    if (!state) return textChannel.send('Нет активного воспроизведения.');
    if (state.index > 0) state.index -= 2; // because playCurrent increments
    state.player.stop(true);
    return textChannel.send('Возвращаюсь к предыдущему.');
}

function stopGuild(guildId, textChannel) {
    const state = guildPlayers.get(guildId);
    if (!state) return textChannel.send('Нет активного воспроизведения.');
    state.queue = [];
    state.player.stop(true);
    try { state.connection.destroy(); } catch (e) {}
    guildPlayers.delete(guildId);
    return textChannel.send('Остановлено и выход из голосового канала.');
}

function setVolumeGuild(guildId, volume, textChannel) {
    const state = guildPlayers.get(guildId);
    if (!state) return textChannel.send('Нет активного воспроизведения.');
    state.volume = Math.max(0, Math.min(1, volume));
    if (state.resource && state.resource.volume) state.resource.volume.setVolume(state.volume);
    return textChannel.send(`Громкость установлена на ${Math.round(state.volume * 100)}%.`);
}

const safeDelete = (item) => item?.delete?.().catch(() => {});

const sendTempEmbed = async (message, embed) => {
    embed.setFooter({ text: '⏳ Сообщение исчезнет через 30 секунд' }).setTimestamp();
    const botMessage = await message.channel.send({ embeds: [embed] });
    safeDelete(message);
    setTimeout(() => safeDelete(botMessage), 30000);
};

const sendError = (message, text) => sendTempEmbed(message, createEmbed({ color: COLORS.error, description: `❌ ${text}` }));

const parseTime = (timeStr) => {
    if (!timeStr) return DEFAULT_MUTE_DURATION;

    const match = timeStr.match(/^(\d+)(мин|час|дн|мес)$/i);
    if (!match) return null;

    const value = Number(match[1]);
    const unit = match[2].toLowerCase();

    if (unit === 'мин') return value * 60 * 1000;
    if (unit === 'час') return value * 60 * 60 * 1000;
    if (unit === 'дн') return value * 24 * 60 * 60 * 1000;
    if (unit === 'мес') return value * 30 * 24 * 60 * 60 * 1000;
    return null;
};

const hasPermission = (member, permission) => member?.permissions?.has(permission);
const getTargetMember = (message) => message.mentions.members.first();

// cooldowns: map of `${command}:${userId}` -> timestamp(ms)
const cooldowns = new Map();
const DEFAULT_COOLDOWNS = {
    'правила': 5,
    'правилапост': 30,
    'варн': 3,
    'бан': 5,
    'мут': 3
};

function checkAndSetCooldown(command, userId) {
    const now = Date.now();
    const cd = DEFAULT_COOLDOWNS[command] || 2;
    const key = `${command}:${userId}`;
    const expire = cooldowns.get(key) || 0;
    if (now < expire) {
        return Math.ceil((expire - now) / 1000);
    }
    cooldowns.set(key, now + cd * 1000);
    return 0;
}

function canRunCommand(member, guildConfig, command, requiredPermission) {
    // check guild-level role overrides
    try {
        const roleList = (guildConfig && guildConfig.roles && guildConfig.roles[command]) || [];
        if (roleList.length) {
            const hasRole = member.roles.cache.some(r => roleList.includes(r.id));
            if (hasRole) return true;
        }
    } catch (err) {
        // ignore
    }

    if (requiredPermission && hasPermission(member, requiredPermission)) return true;
    return false;
}

const getRulesEmbed = (arg) => {
    const ruleType = arg === 'чата' ? 'chat' : arg === 'войса' ? 'voice' : 'main';
    const ruleData = {
        main: {
            color: COLORS.rules,
            title: msgs.rules.main_title,
            description: msgs.rules.main_desc.join('\n')
        },
        chat: {
            color: COLORS.success,
            title: msgs.rules.chat_title,
            description: msgs.rules.chat_desc.join('\n')
        },
        voice: {
            color: COLORS.mute,
            title: msgs.rules.voice_title,
            description: msgs.rules.voice_desc.join('\n')
        }
    }[ruleType];

    return createEmbed(ruleData);
};

client.once('ready', async () => {
    console.log(`Бот ${client.user.tag} готов!`);

    const commands = [
        {
            name: 'правила',
            description: 'Показать правила сервера (основные)'
        },
        {
            name: 'плей',
            description: 'Искать трек на YouTube и показать варианты',
            options: [
                { name: 'запрос', description: 'Ключевые слова для поиска', type: 3, required: true }
            ]
        },
        {
            name: 'правилапост',
            description: 'Опубликовать (или обновить) пост с правилами',
            options: [
                { name: 'канал', description: 'Канал для публикации', type: 7, required: false }
            ]
        },
        { name: 'пауза', description: 'Пауза воспроизведения' },
        { name: 'луп', description: 'Переключить зацикливание трека' },
        { name: 'некст', description: 'Следующий трек' },
        { name: 'пред', description: 'Предыдущий трек' },
        { name: 'стоп', description: 'Остановить воспроизведение и выйти из войса' },
        { name: 'громкость', description: 'Установить громкость (1-100)', options: [{ name: 'значение', description: 'Значение громкости', type: 4, required: true }] }
    ];

    try {
        if (process.env.GUILD_ID) {
            const guild = client.guilds.cache.get(process.env.GUILD_ID) || await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
            if (guild) {
                await guild.commands.set(commands);
                console.log('Slash commands registered for guild');
            }
        } else if (client.application) {
            await client.application.commands.set(commands);
            console.log('Slash commands registered globally');
        }
    } catch (err) {
        console.error('Failed to register slash commands', err);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const guildId = interaction.guildId;
    const guildConfig = guildId ? storage.getGuildConfig(guildId) : null;

    try {
        if (commandName === 'плей') {
            const query = interaction.options.getString('запрос');
            if (!query) return interaction.reply({ content: 'Укажите запрос для поиска.', ephemeral: true });

            // perform search
            const results = await searchYouTube(query);
            if (!results || !results.length) return interaction.reply({ content: 'Ничего не найдено.', ephemeral: true });

            const list = results.map((r, i) => `${i + 1}. ${r.title}`).join('\n');
            const guildId = interaction.guildId || (interaction.guild && interaction.guild.id);
            if (guildId) searchResults.set(guildId, results.map(r => ({ title: r.title, url: r.url })));

            await interaction.reply({ content: `найдена\n${list}`, ephemeral: false });
            return;
        }

        if (commandName === 'пауза') {
            const guildId = interaction.guildId;
            pauseGuild(guildId, interaction.channel);
            return interaction.reply({ content: 'Пауза.', ephemeral: true });
        }

        if (commandName === 'луп') {
            const guildId = interaction.guildId;
            const state = guildPlayers.get(guildId);
            if (!state) return interaction.reply({ content: 'Нет активного воспроизведения.', ephemeral: true });
            state.looping = !state.looping;
            return interaction.reply({ content: `Loop: ${state.looping ? 'включен' : 'выключен'}`, ephemeral: true });
        }

        if (commandName === 'некст') {
            const guildId = interaction.guildId;
            skipGuild(guildId, interaction.channel);
            return interaction.reply({ content: 'Пропускаю.', ephemeral: true });
        }

        if (commandName === 'пред') {
            const guildId = interaction.guildId;
            prevGuild(guildId, interaction.channel);
            return interaction.reply({ content: 'Назад.', ephemeral: true });
        }

        if (commandName === 'стоп') {
            const guildId = interaction.guildId;
            stopGuild(guildId, interaction.channel);
            return interaction.reply({ content: 'Остановлено.', ephemeral: true });
        }

        if (commandName === 'громкость') {
            const val = interaction.options.getInteger('значение') || 50;
            const guildId = interaction.guildId;
            setVolumeGuild(guildId, Math.max(1, Math.min(100, val)) / 100, interaction.channel);
            return interaction.reply({ content: `Громкость установлена на ${val}%`, ephemeral: true });
        }

        if (commandName === 'правила') {
            const embed = createEmbed({ color: COLORS.rules, title: msgs.rules.main_title, description: msgs.rules.main_desc.join('\n') });
            return interaction.reply({ embeds: [embed] });
        }

        if (commandName === 'правилапост') {
            if (!canRunCommand(interaction.member, guildConfig, 'правилапост', PermissionsBitField.Flags.ManageGuild)) {
                return interaction.reply({ content: 'Нет прав.', ephemeral: true });
            }

            const channel = interaction.options.getChannel('канал') || interaction.channel;
            if (!channel) return interaction.reply({ content: 'Канал не найден.', ephemeral: true });

            const embed = createEmbed({ color: COLORS.rules, title: msgs.rules.main_title, description: msgs.rules.main_desc.join('\n') });

            const sent = await channel.send({ embeds: [embed] }).catch(err => { console.error(err); return null; });
            if (!sent) return interaction.reply({ content: 'Не удалось отправить сообщение в канал.', ephemeral: true });

            // save message id in guild config
            if (guildId) {
                const cfg = storage.getGuildConfig(guildId) || {};
                cfg.rulesMessageId = sent.id;
                storage.setGuildConfig(guildId, cfg);
            }

            return interaction.reply({ content: 'Правила успешно опубликованы.', ephemeral: true });
        }
    } catch (err) {
        console.error('interaction error', err);
        if (!interaction.replied) interaction.reply({ content: 'Внутренняя ошибка.', ephemeral: true });
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // react to a specific GIF URL anywhere in the message
    try {
        const gifMatch = 'https://cdn.discordapp.com/attachments/1439315432698937665/1517449883693486170/image.gif';
        if (message.content && message.content.includes(gifMatch)) {
            // reply with emojis as requested
            await message.channel.send('Ох ебать, это-же Кiкс! 😳🔥🤣');
            return;
        }
    } catch (err) {
        // ignore any errors while checking/reacting
    }

    if (!message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const targetMember = getTargetMember(message);

    try {
        switch (command) {
            case 'правила':
                return sendTempEmbed(message, getRulesEmbed(args[0]));

            case 'инфо':
                return sendTempEmbed(message, createEmbed({ color: COLORS.info, title: msgs.info_title, description: msgs.info_desc.join('\n') }));

            case 'плей': {
                const query = args.join(' ');
                if (!query) return sendError(message, 'Укажите запрос для поиска.');

                const results = await searchYouTube(query);
                if (!results || !results.length) return sendTempEmbed(message, createEmbed({ color: COLORS.info, description: 'Ничего не найдено.' }));

                const list = results.map((r, i) => `${i + 1}. ${r.title}`).join('\n');
                searchResults.set(message.guild.id, results.map(r => ({ title: r.title, url: r.url })));

                return sendTempEmbed(message, createEmbed({ color: COLORS.info, title: 'найдена', description: list }));
            }

            case '1':
            case '2':
            case '3':
            case '4':
            case '5': {
                const idx = Number(command) - 1;
                const guildId = message.guild && message.guild.id;
                const list = guildId ? searchResults.get(guildId) : null;
                if (!list || !list[idx]) return sendError(message, 'Нет сохранённого результата для этой позиции.');

                const track = list[idx];
                return enqueueTrack(message.member, { title: track.title, url: track.url }, message.channel);
            }

            case 'пауза': {
                pauseGuild(message.guild.id, message.channel);
                return sendTempEmbed(message, createEmbed({ color: COLORS.info, description: 'Пауза.' }));
            }

            case 'луп': {
                const state = guildPlayers.get(message.guild.id);
                if (!state) return sendError(message, 'Нет активного воспроизведения.');
                state.looping = !state.looping;
                return sendTempEmbed(message, createEmbed({ color: COLORS.info, description: `Loop: ${state.looping ? 'вкл' : 'выкл'}` }));
            }

            case 'некст': {
                skipGuild(message.guild.id, message.channel);
                return sendTempEmbed(message, createEmbed({ color: COLORS.info, description: 'Пропущено.' }));
            }

            case 'пред': {
                prevGuild(message.guild.id, message.channel);
                return sendTempEmbed(message, createEmbed({ color: COLORS.info, description: 'Предыдущий трек.' }));
            }

            case 'стоп': {
                stopGuild(message.guild.id, message.channel);
                return sendTempEmbed(message, createEmbed({ color: COLORS.info, description: 'Остановлено и вышел из голосового канала.' }));
            }

            case 'громкость': {
                const val = Number(args[0]);
                if (!val || isNaN(val) || val < 1 || val > 100) return sendError(message, 'Укажите громкость от 1 до 100.');
                setVolumeGuild(message.guild.id, Math.max(1, Math.min(100, val)) / 100, message.channel);
                return sendTempEmbed(message, createEmbed({ color: COLORS.info, description: `Громкость установлена на ${val}%` }));
            }

            case 'варн': {
                if (!hasPermission(message.member, PermissionsBitField.Flags.BanMembers)) return sendError(message, 'Нет прав.');
                if (!targetMember) return sendError(message, 'Укажите пользователя.');

                const warns = (warnsDatabase.get(targetMember.id) || 0) + 1;
                warnsDatabase.set(targetMember.id, warns);

                if (warns >= 3) {
                    warnsDatabase.delete(targetMember.id);
                    await targetMember.ban({ reason: 'Автобан 3/3 варнов.' });
                    return sendTempEmbed(message, createEmbed({ color: COLORS.ban, description: `🚨 **${targetMember.user.tag}** забанен (3/3 варнов).` }));
                }

                return sendTempEmbed(message, createEmbed({ color: COLORS.warn, description: `⚠️ **${targetMember.user.tag}** получил варн! [**${warns}/3**]` }));
            }

            case 'снятьварн': {
                if (!hasPermission(message.member, PermissionsBitField.Flags.BanMembers)) return sendError(message, 'Нет прав.');
                if (!targetMember) return sendError(message, 'Укажите пользователя.');

                const warns = warnsDatabase.get(targetMember.id) || 0;
                if (!warns) return sendError(message, 'У пользователя нет предупреждений.');

                warnsDatabase.set(targetMember.id, warns - 1);
                return sendTempEmbed(message, createEmbed({ color: COLORS.success, description: `✅ Снят варн у **${targetMember.user.tag}**. Осталось: [**${warns - 1}/3**]` }));
            }

            case 'варны': {
                if (!targetMember) return sendError(message, 'Укажите пользователя.');
                return sendTempEmbed(message, createEmbed({ color: COLORS.info, description: `У **${targetMember.user.username}** варнов: **${warnsDatabase.get(targetMember.id) || 0}/3**` }));
            }

            case 'мут': {
                if (!hasPermission(message.member, PermissionsBitField.Flags.ModerateMembers)) return sendError(message, 'Нет прав.');
                if (!targetMember) return sendError(message, 'Укажите пользователя.');

                const duration = parseTime(args[1]);
                if (!duration) return sendError(message, 'Неверный формат времени (пример: 5мин, 2час, 1дн).');
                if (duration > MAX_MUTE_DURATION) return sendError(message, 'Discord разрешает мут максимум на 28 дней.');

                await targetMember.timeout(duration, 'Мут');
                return sendTempEmbed(message, createEmbed({ color: COLORS.mute, description: `🔇 **${targetMember.user.tag}** замучен.` }));
            }

            case 'размут': {
                if (!hasPermission(message.member, PermissionsBitField.Flags.ModerateMembers)) return sendError(message, 'Нет прав.');
                if (!targetMember) return sendError(message, 'Укажите пользователя.');

                await targetMember.timeout(null);
                return sendTempEmbed(message, createEmbed({ color: COLORS.success, description: `🔊 **${targetMember.user.tag}** размучен.` }));
            }

            case 'муты': {
                await message.guild.members.fetch();
                const muted = message.guild.members.cache.filter((member) => member.isCommunicationDisabled());
                if (!muted.size) return sendTempEmbed(message, createEmbed({ color: COLORS.info, description: '📭 Нет замученных.' }));

                const list = muted.map((member) => `• **${member.user.tag}**`).join('\n');
                return sendTempEmbed(message, createEmbed({ color: COLORS.mute, title: '🔇 Список в муте', description: list }));
            }

            case 'бан': {
                if (!hasPermission(message.member, PermissionsBitField.Flags.BanMembers)) return sendError(message, 'Нет прав.');
                if (!targetMember) return sendError(message, 'Укажите пользователя.');

                await targetMember.ban();
                return sendTempEmbed(message, createEmbed({ color: COLORS.error, description: `🔨 **${targetMember.user.tag}** забанен.` }));
            }

            case 'разбан': {
                if (!hasPermission(message.member, PermissionsBitField.Flags.BanMembers)) return sendError(message, 'Нет прав.');
                if (!args[0]) return sendError(message, 'Укажите ID пользователя (пинг не сработает).');

                const user = await message.guild.members.unban(args[0]);
                return sendTempEmbed(message, createEmbed({ color: COLORS.success, description: `🔓 **${user.tag}** разбанен.` }));
            }

            case 'баны': {
                if (!hasPermission(message.member, PermissionsBitField.Flags.BanMembers)) return sendError(message, 'Нет прав.');

                const bans = await message.guild.bans.fetch().catch(() => null);
                if (!bans || !bans.size) return sendTempEmbed(message, createEmbed({ color: COLORS.info, description: '📭 Список банов пуст.' }));

                const list = bans.map((ban) => `• **${ban.user.tag}** (ID: ${ban.user.id})`).join('\n');
                return sendTempEmbed(message, createEmbed({ color: COLORS.error, title: '🔨 Баны сервера', description: list }));
            }

            case 'правилапост': {
                const guildId = message.guild?.id;
                const guildConfig = guildId ? storage.getGuildConfig(guildId) : null;

                if (!canRunCommand(message.member, guildConfig, 'правилапост', PermissionsBitField.Flags.ManageGuild)) return sendError(message, 'Нет прав.');

                // cooldown
                const rem = checkAndSetCooldown('правилапост', message.author.id);
                if (rem > 0) return sendError(message, `Подождите ${rem}s перед повторной публикацией.`);

                const targetChannel = message.mentions.channels.first() || (args[0] && message.guild.channels.cache.get(args[0])) || message.channel;
                if (!targetChannel) return sendError(message, 'Канал не найден.');

                const embed = createEmbed({ color: COLORS.rules, title: msgs.rules.main_title, description: msgs.rules.main_desc.join('\n') });

                // If a previous message id exists, try to edit it
                if (guildConfig && guildConfig.rulesMessageId) {
                    try {
                        const prev = await targetChannel.messages.fetch(guildConfig.rulesMessageId).catch(() => null);
                        if (prev) {
                            await prev.edit({ embeds: [embed] });
                            return sendTempEmbed(message, createEmbed({ color: COLORS.success, description: 'Правила обновлены.' }));
                        }
                    } catch (err) {
                        console.error('Failed to edit existing rules message', err);
                    }
                }

                const sent = await targetChannel.send({ embeds: [embed] }).catch((err) => {
                    console.error('Send rules post error:', err);
                    return null;
                });

                if (!sent) return sendError(message, 'Не удалось отправить сообщение в канал.');

                if (guildId) {
                    const cfg = storage.getGuildConfig(guildId) || {};
                    cfg.rulesMessageId = sent.id;
                    storage.setGuildConfig(guildId, cfg);
                }

                return sendTempEmbed(message, createEmbed({ color: COLORS.success, description: 'Правила успешно опубликованы.' }));
            }

            default:
                return;
        }
    } catch (error) {
        console.error('Ошибка команды:', command, error);
        return sendError(message, 'Произошла внутренняя ошибка.');
    }
});

client.login(process.env.DISCORD_TOKEN);



// Graceful shutdown on SIGTERM/SIGINT
const gracefulShutdown = async (signal) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    try {
        await client.destroy();
        console.log('Client destroyed, exiting process');
        process.exit(0);
    } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
    }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});