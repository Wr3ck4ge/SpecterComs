import pg from 'pg';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://specter_admin:admin_password_123@localhost:5433/specter_prod',
});

/** Generate a cryptographically secure 24-character password */
function generatePassword(): string {
    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*';
    return Array.from(crypto.randomBytes(24))
        .map(b => charset[b % charset.length])
        .join('');
}

async function main() {
    // Usage: npx ts-node create-root.ts <username> <email> [password]
    const username = process.argv[2] || 'specter_root';
    const email    = process.argv[3] || null;
    const password = process.argv[4] || generatePassword();

    if (!email) {
        console.error('Usage: npx ts-node create-root.ts <username> <email> [password]');
        process.exit(1);
    }

    console.log(`Checking existing platform admins...`);
    const checkRes = await pool.query(
        'SELECT username FROM platform_admins WHERE username = $1 OR email = $2',
        [username, email]
    );
    
    if (checkRes.rows.length > 0) {
        console.error(`Error: Admin user '${username}' or email '${email}' already exists.`);
        process.exit(1);
    }

    console.log(`Generating root credentials for '${username}' <${email}>...`);
    
    // 1. Hash Password (Argon2id)
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    // 2. Generate TOTP Secret
    const rotpSecret = crypto.randomBytes(20).toString('base64').replace(/[^A-Z2-7]/gi, 'A').slice(0, 32).toUpperCase();

    // 3. Define Master Permissions
    const permissions = JSON.stringify({ can_ban_global: true, super_admin: true });

    try {
        await pool.query(
            `INSERT INTO platform_admins (id, username, email, password_hash, rotp_secret, permissions, last_login)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW())`,
             [username, email, passwordHash, rotpSecret, permissions]
        );
        console.log('');
        console.log('✅  Root platform admin created.');
        console.log('─────────────────────────────────────────');
        console.log(`  Username : ${username}`);
        console.log(`  Email    : ${email}`);
        console.log(`  Password : ${password}`);
        console.log(`  2FA Seed : ${rotpSecret}`);
        console.log('─────────────────────────────────────────');
        console.log('⚠  Save these credentials — they will not be shown again.');
        console.log('');
    } catch(err) {
        console.error('❌ Failed to create admin:', err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

main();