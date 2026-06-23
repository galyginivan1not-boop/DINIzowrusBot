const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(filePath, defaultValue = null) {
    try {
        if (!fs.existsSync(filePath)) return defaultValue;
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        console.error('readJSON error', filePath, err);
        return defaultValue;
    }
}

function writeJSON(filePath, data) {
    try {
        ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (err) {
        console.error('writeJSON error', filePath, err);
        return false;
    }
}

const DATA_DIR = path.join(__dirname, '..', 'data');
ensureDir(DATA_DIR);

function getGuildConfig(guildId) {
    const file = path.join(DATA_DIR, 'configs', `${guildId}.json`);
    const def = { prefix: '?', rulesMessageId: null, roles: {}, cooldowns: {} };
    return readJSON(file, def);
}

function setGuildConfig(guildId, config) {
    const file = path.join(DATA_DIR, 'configs', `${guildId}.json`);
    return writeJSON(file, config);
}

module.exports = { readJSON, writeJSON, getGuildConfig, setGuildConfig, DATA_DIR };
