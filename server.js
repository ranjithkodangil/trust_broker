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

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// JWK Endpoint - Serves a specific public key by id
app.get('/.well-known/jwk', async (req, res) => {
    try {
        const { id } = req.query;

        if (!id) {
            return res.status(400).json({ error: "Missing 'id' query parameter" });
        }

        // Check Database-backed keys
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

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

/**
 * API to list all available Key IDs (KIDs)
 */
app.get('/keys/list', async (req, res) => {
    try {
        let dbKids = [];

        try {
            const dbResult = await pool.query('SELECT kid FROM trust_broker.jwks_keys');
            dbKids = dbResult.rows.map(row => row.kid);
        } catch (dbErr) {
            console.error('Database query for keys failed:', dbErr.message);
        }

        res.json(dbKids);
    } catch (err) {
        console.error('Error listing keys:', err);
        res.status(500).json({ error: 'Failed to list keys' });
    }
});

// Issuing Endpoint - Requires x-key-id header
app.post('/issue-token', async (req, res) => {
    try {
        const { payload } = req.body;
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

        // Check Database-backed keys
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
            .setIssuer(`${req.protocol}://${req.get('host')}`)
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

// --- Key Management APIs ---



/**
 * API to generate and store a new JWK in the database.
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

// Catch-all route to serve index.html for all other requests
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => {
        console.log(`\n🚀 Multi-Key JWK Auth Server running locally at:`);
        console.log(`   http://localhost:${port}`);
        console.log(`\n🔑 JWK Lookup Endpoint:`);
        console.log(`   http://localhost:${port}/.well-known/jwk?id=<kid>\n`);
    });
}

export default app;
