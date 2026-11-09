import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { Pool } from 'pg';
const app = express();
const port = process.env.PORT || 3000;
// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
// Database Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});
// Health Check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
// Start Server
app.listen(port, () => {
    console.log(`Identity Service running on port ${port}`);
});
// Graceful Shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing pool...');
    await pool.end();
    process.exit(0);
});
//# sourceMappingURL=index.js.map