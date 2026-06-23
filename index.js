require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
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
        GatewayIntentBits.GuildModeration
    ]
});

const createEmbed = ({ color = COLORS.info, title, description }) => {
    const embed = new EmbedBuilder().setColor(color);
    if (title) embed.setTitle(title);
    if (description) embed.setDescription(description);
    return embed;
};

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

    // Register basic slash commands (global)
    const commands = [
        {
            name: 'правила',
            description: 'Показать правила сервера (основные)'
        },
        {
            name: 'правилапост',
            description: 'Опубликовать (или обновить) пост с правилами',
            options: [
                { name: 'канал', description: 'Канал для публикации', type: 7, required: false }
            ]
        }
    ];

    try {
        await client.application.commands.set(commands);
        console.log('Slash commands registered');
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
    if (message.author.bot || !message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const targetMember = getTargetMember(message);

    try {
        switch (command) {
            case 'правила':
                return sendTempEmbed(message, getRulesEmbed(args[0]));

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