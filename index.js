const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const util = require('util');
const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const execPromise = util.promisify(exec);
const db = new sqlite3.Database('./atmos_cache.db');

db.run(`
    CREATE TABLE IF NOT EXISTS atmos_streams (
        id TEXT PRIMARY KEY,
        has_atmos INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

const dbGet = util.promisify(db.get.bind(db));
const dbRun = util.promisify(db.run.bind(db));

async function getCachedStatus(id) {
    const row = await dbGet('SELECT has_atmos FROM atmos_streams WHERE id = ?', [id]);
    return row ? Boolean(row.has_atmos) : null;
}

async function setCachedStatus(id, hasAtmos) {
    await dbRun('INSERT OR REPLACE INTO atmos_streams (id, has_atmos) VALUES (?, ?)', [id, hasAtmos ? 1 : 0]);
}

async function verifyAtmos(streamUrl) {
    const cmd = `ffprobe -v quiet -print_format json -show_streams -select_streams a -probesize 20000000 "${streamUrl}"`;
    try {
        const { stdout } = await execPromise(cmd);
        const metadata = JSON.parse(stdout);
        if (!metadata.streams) return false;
        
        return metadata.streams.some(stream => {
            const codec = stream.codec_name;
            const channels = stream.channels;
            const title = stream.tags?.title?.toLowerCase() || '';
            return title.includes('atmos') || (codec === 'truehd' && channels >= 8);
        });
    } catch (error) {
        return false;
    }
}

// Pulls securely from Render's environment variables
const SOOTIO_BASE_URL = process.env.SOOTIO_BASE_URL;

const builder = new addonBuilder({
    id: 'org.atmos.validator',
    version: '1.1.0',
    name: 'Atmos Validator',
    description: 'Filters Sootio streams to guarantee Dolby Atmos tracks.',
    resources: ['stream'],
    types: ['movie', 'series'],
    catalogs: []
});

builder.defineStreamHandler(async (args) => {
    try {
        const response = await axios.get(`${SOOTIO_BASE_URL}/stream/${args.type}/${args.id}.json`);
        const rawStreams = response.data.streams || [];
        
        const remuxStreams = rawStreams.filter(stream => 
            (stream.title || '').toLowerCase().includes('remux') || 
            (stream.name || '').toLowerCase().includes('remux')
        );

        const topStreams = remuxStreams.slice(0, 5);
        const validationPromises = topStreams.map(async (stream) => {
            if (!stream.url) return null;
            
            const cacheId = stream.infoHash || stream.title;
            let hasAtmos = await getCachedStatus(cacheId);

            if (hasAtmos === null) {
                hasAtmos = await verifyAtmos(stream.url);
                await setCachedStatus(cacheId, hasAtmos);
            }

            if (hasAtmos) {
                stream.name = `[Atmos Verified]\n${stream.name}`;
                return stream;
            }
            return null;
        });

        const results = await Promise.all(validationPromises);
        return { streams: results.filter(s => s !== null) };
    } catch (error) {
        return { streams: [] };
    }
});

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
