import express from 'express';
import * as jose from 'jose';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY_DIR = path.join(__dirname, 'keys');

const app = express();
const port = process.env.PORT || 3000;

// Store multiple keys indexed by kid
const keys = {};

async function ensureKey(id) {
    const kid = `demo-key-${id}`;
    const privPath = path.join(KEY_DIR, `private-${id}.pem`);
    const pubPath = path.join(KEY_DIR, `public-${id}.pem`);

    let privateKey, publicKey;

    try {
        const privatePem = await fs.readFile(privPath, 'utf8');
        const publicPem = await fs.readFile(pubPath, 'utf8');
        privateKey = await jose.importPKCS8(privatePem, 'RS256');
        publicKey = await jose.importSPKI(publicPem, 'RS256');
        console.log(`Loaded key: ${kid}`);
    } catch (e) {
        console.log(`Generating new key: ${kid}...`);
        const { publicKey: pub, privateKey: priv } = await jose.generateKeyPair('RS256', {
            extractable: true,
            modulusLength: 2048,
        });
        privateKey = priv;
        publicKey = pub;

        const privatePem = await jose.exportPKCS8(privateKey);
        const publicPem = await jose.exportSPKI(publicKey);

        await fs.writeFile(privPath, privatePem);
        await fs.writeFile(pubPath, publicPem);
        console.log(`Key ${kid} generated and saved`);
    }

    const jwk = await jose.exportJWK(publicKey);
    jwk.kid = kid;
    jwk.alg = 'RS256';
    jwk.use = 'sig';

    keys[kid] = { privateKey, publicKey, jwk };
}

async function ensureAllKeys() {
    try {
        await fs.mkdir(KEY_DIR, { recursive: true });
        // Guarantee at least 3 keys on disk
        await Promise.all([1, 2, 3].map(ensureKey));
    } catch (err) {
        console.error('Error managing keys:', err);
        process.exit(1);
    }
}

app.use(express.static('public'));
app.use(express.json());

// JWK Endpoint - Serves a specific public key by id
app.get('/.well-known/jwk', async (req, res) => {
    try {
        const { id } = req.query;

        if (!id) {
            return res.status(400).json({ error: "Missing 'id' query parameter" });
        }

        // 1. Check disk-based keys first
        if (keys[id]) {
            return res.json(keys[id].jwk);
        }

        // 2. Check Database-backed keys
        const result = await pool.query(
            'SELECT jwk FROM trust_broker.jwks_keys WHERE kid = $1',
            [id]
        );

        if (result.rows.length > 0) {
            return res.json(result.rows[0].jwk);
        }

        res.status(404).json({ error: `Key with ID '${id}' not found` });
    } catch (err) {
        console.error('Error fetching JWK:', err);
        res.status(500).json({ error: 'Failed to fetch JWK', details: err.message });
    }
});

// Issuing Endpoint - Requires x-key-id header
app.post('/issue-token', async (req, res) => {
    try {
        const { payload = { sub: 'demo-user' } } = req.body;
        const kid = req.headers['x-key-id'];

        // Validation: Ensure kid is provided in the header
        if (!kid) {
            return res.status(400).json({ 
                error: "Missing required header: 'x-key-id'",
                message: "Please specify which key to use for signing via the 'x-key-id' header."
            });
        }

        let privateKey, expirationTime, audience;
        const DEFAULT_AUDIENCE = 'demo-app';
        const DEFAULT_EXPIRATION = '2h';

        // 1. Check in-memory keys
        if (keys[kid]) {
            privateKey = keys[kid].privateKey;
            audience = DEFAULT_AUDIENCE;
            expirationTime = DEFAULT_EXPIRATION;
        } else {
            // 2. Check Database-backed keys
            const result = await pool.query(
                'SELECT private_key, expiration_time, audience FROM trust_broker.jwks_keys WHERE kid = $1',
                [kid]
            );

            if (result.rows.length > 0) {
                // Import the PKCS8 private key string
                privateKey = await jose.importPKCS8(result.rows[0].private_key, 'RS256');
                expirationTime = result.rows[0].expiration_time || DEFAULT_EXPIRATION;
                audience = result.rows[0].audience || DEFAULT_AUDIENCE;
            }
        }

        // Validation: Ensure the key was found
        if (!privateKey) {
            return res.status(400).json({ 
                error: "Invalid Key ID",
                message: `The key ID '${kid}' was not found on this server or in the database.`
            });
        }

        const jwt = await new jose.SignJWT(payload)
            .setProtectedHeader({ alg: 'RS256', kid: kid })
            .setIssuedAt()
            .setIssuer(`http://localhost:${port}`)
            .setAudience(audience)
            .setExpirationTime(expirationTime)
            .sign(privateKey);

        res.json({ 
            token: jwt,
            kid: kid
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to issue token', details: err.message });
    }
});

/**
 * API to generate and store a new JWK in the database.
 * Body: { kid: string, expiration_time: string, audience: string }
 */
app.post('/keys', async (req, res) => {
    try {
        const { kid, expiration_time, audience } = req.body;

        if (!kid || !expiration_time || !audience) {
            return res.status(400).json({ error: 'Missing required fields: kid, expiration_time, and audience' });
        }

        // Generate a new RSA-256 key pair
        const { publicKey, privateKey } = await jose.generateKeyPair('RS256', {
            extractable: true,
            modulusLength: 2048,
        });

        // Export keys to PEM strings for storage
        const privatePem = await jose.exportPKCS8(privateKey);
        const publicPem = await jose.exportSPKI(publicKey);

        // Export public key as JWK
        const jwk = await jose.exportJWK(publicKey);
        jwk.kid = kid;
        jwk.alg = 'RS256';
        jwk.use = 'sig';

        // Save to database
        const insertQuery = `
            INSERT INTO trust_broker.jwks_keys (kid, jwk, private_key, public_key, expiration_time, audience)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING kid, expiration_time, audience;
        `;
        const result = await pool.query(insertQuery, [kid, JSON.stringify(jwk), privatePem, publicPem, expiration_time, audience]);

        res.status(201).json({
            message: 'Key generated and saved successfully',
            key: result.rows[0]
        });
    } catch (err) {
        console.error('Error in /keys endpoint:', err);
        if (err.code === '23505') { // Unique violation in Postgres
            return res.status(409).json({ error: `Key with ID '${req.body.kid}' already exists.` });
        }
        res.status(500).json({ error: 'Failed to generate key', details: err.message });
    }
});

// Initialize keys and start server
await ensureAllKeys();

app.listen(port, () => {
    console.log(`\n🚀 Multi-Key JWK Auth Server running at:`);
    console.log(`   http://localhost:${port}`);
    console.log(`\n🔑 JWK Lookup Endpoint:`);
    console.log(`   http://localhost:${port}/.well-known/jwk?id=<kid>\n`);
});
