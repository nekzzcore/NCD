// Electron: данные пользователя вне app.asar и обновляемых веб-ассетов.
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

function createProfileStore(directory, legacyFiles = []) {
    const file = path.join(directory, 'profile.json');
    const accountFile = identity => {
        if (typeof identity !== 'string' || !/^https:\/\/[^|]+\|[^|]+$/.test(identity)) throw new Error('Invalid account identity');
        return path.join(directory, 'accounts', createHash('sha256').update(identity).digest('hex') + '.json');
    };
    const authFile = path.join(directory, 'auth-session.json');
    const validAuthKey = key => typeof key === 'string' && key.length <= 512 && /^(gt-supabase-auth:https?:\/\/|tokens\.)/.test(key);
    function authEntries() {
        try { return JSON.parse(fs.readFileSync(authFile,'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    }
    return {
        readAuth(key) {
            if (!validAuthKey(key)) throw new Error('Invalid auth storage key');
            return authEntries()[key] ?? null;
        },
        writeAuth(key, value) {
            if (!validAuthKey(key) || (value !== null && typeof value !== 'string')) throw new Error('Invalid auth storage value');
            const entries = authEntries();
            if (value === null) delete entries[key]; else entries[key] = value;
            fs.mkdirSync(directory, { recursive:true, mode:0o700 });
            const temporary = authFile + '.tmp';
            fs.writeFileSync(temporary, JSON.stringify(entries), { mode:0o600 });
            const fd = fs.openSync(temporary,'r');
            try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            fs.renameSync(temporary,authFile);
        },
        readAccount(identity) {
            try {
                const saved = JSON.parse(fs.readFileSync(accountFile(identity), 'utf8'));
                if (saved.identity !== identity) throw new Error('Account identity mismatch');
                return saved.data;
            } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        },
        writeAccount(identity, data) {
            const target = accountFile(identity);
            fs.mkdirSync(path.dirname(target), { recursive:true, mode:0o700 });
            const temporary = target + '.tmp';
            fs.writeFileSync(temporary, JSON.stringify({ identity, data }), { mode:0o600 });
            const fd = fs.openSync(temporary, 'r');
            try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            fs.renameSync(temporary, target);
        },
        read() {
            try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
            catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        },
        readLegacy() {
            for (const legacy of legacyFiles) {
                try {
                    const data = JSON.parse(fs.readFileSync(legacy, 'utf8'));
                    if (data?.user) return data;
                } catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            return null;
        },
        clear(data) {
            this.write(data);
            // These files are legacy profile stores, not cloud data.
            for (const legacy of legacyFiles) {
                if (legacy === file || !fs.existsSync(legacy)) continue;
                try { fs.writeFileSync(legacy, JSON.stringify(data), { mode:0o600 }); }
                catch (error) { if (!legacy.includes('.asar') || !['EACCES','EROFS','ENOTDIR','ENOENT'].includes(error.code)) throw error; }
            }
        },
        write(data) {
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid profile');
            fs.mkdirSync(directory, { recursive: true });
            const temporary = file + '.tmp';
            fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
            const fd = fs.openSync(temporary, 'r');
            try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            fs.renameSync(temporary, file);
        }
    };
}
module.exports = { createProfileStore };
