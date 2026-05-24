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

async function verifyAtmos(streamUrl, releaseName) {
    const cmd = `ffprobe -v quiet -print_format json -show_streams -select_streams a -probesize 20000000 "${streamUrl}"`;
    try {
        const { stdout } = await execPromise(cmd);
        const metadata = JSON.parse(stdout);
        if (!metadata.streams) return false;
        
        return metadata.streams.some(stream => {
            const codec = stream.codec_name;
            const internalTitle = stream.tags?.title?.toLowerCase() || '';
            const profile = stream.profile?.toLowerCase() || '';
            const codecLongName = stream.codec_long_name?.toLowerCase() || '';
            
            const hasInternalTag = internalTitle.includes('atmos');
            const hasExternalTag = (releaseName || '').toLowerCase().includes('atmos');
            const hasProfileTag = profile.includes('atmos') || codecLongName.includes('atmos');

            const isAtmosTagged = hasInternalTag || hasExternalTag || hasProfileTag;
            
            // Allow both TrueHD (Remux) and E-AC-3 (WEB-DL) Atmos
            return (codec === 'truehd' || codec === 'eac3') && isAtmosTagged;
        });
    } catch (error) {
        return false;
    }
}

const SOOTIO_BASE_URL = process.env.SOOTIO_BASE_URL;

const builder = new addonBuilder({
    id: 'org.atmos.validator',
    version: '1.6.0',
    name: 'Atmos Validator',
    description: 'Filters Sootio streams to guarantee Dolby Atmos tracks.',
    logo: 'https://raw.githubusercontent.com/liamribrown/atmos-validator/refs/heads/main/1779608583417.png',
    resources: ['stream'],
    types: ['movie', 'series'],
    catalogs: []
});

builder.defineStreamHandler(async (args) => {
    try {
        const response = await axios.get(`${SOOTIO_BASE_URL}/stream/${args.type}/${args.id}.json`);
        const rawStreams = response.data.streams || [];
        
        [span_2](start_span)// Removed the strict 'remux' pre-filter. 
        // Sootio natively prioritizes top quality streams (Remux > BluRay > WEB-DL)[span_2](end_span).
        const topStreams = rawStreams.slice(0, 3);

        const validationPromises = topStreams.map(async (stream) => {
            if (!stream.url) return null;
            
            const cacheId = stream.infoHash || stream.title;
            let hasAtmos = await getCachedStatus(cacheId);

            if (hasAtmos === null) {
                hasAtmos = await verifyAtmos(stream.url, stream.title);
                await setCachedStatus(cacheId, hasAtmos);
            }

            if (hasAtmos) {
                stream.name = `🌌 ATMOS\n[Sootio]`;
                stream.title = `🔊 DEBRID | DOLBY ATMOS ✅\n${stream.title}`;
                return stream;
            }
            return null;
        });

        const results = await Promise.all(validationPromises);
        const validStreams = results.filter(s => s !== null);

        if (validStreams.length === 0) {
            return {
                streams: [{
                    name: '⚠️ NOTICE',
                    title: 'No Dolby Atmos metadata verified for this title.\nUse original Sootio instance for standard tracks.',
                    externalUrl: 'https://stremio.com' 
                }]
            };
        }

        return { streams: validStreams };
    } catch (error) {
        return { 
            streams: [{
                name: '❌ ERROR',
                title: 'Failed to fetch or validate streams from upstream.',
                externalUrl: 'https://stremio.com'
            }] 
        };
    }
});

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
