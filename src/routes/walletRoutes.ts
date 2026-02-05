import { Router } from 'express';
import { supabase } from '../db/supabaseClient.js';
import CryptoService from '../services/CryptoService.js';

const router = Router();

// Get server public key
router.get('/keys', (req, res) => {
    res.json({ public_key: CryptoService.getPublicKey() });
});

// Initialize user/device
router.post('/initialize', async (req, res) => {
    console.log('Initialize request body:', req.body);
    const { user_id, public_key } = req.body;
    if (!user_id || !public_key) return res.status(400).json({ error: 'Missing parameters' });

    try {
        // Use UPSERT (insert with onConflict)
        const { error } = await supabase
            .from('users')
            .upsert({ id: user_id, public_key })
            .select();

        if (error) throw error;

        console.log(`✅ Initialized/Updated user: ${user_id}`);
        res.json({ status: 'ok' });
    } catch (err) {
        console.error('Initialize Error:', err);
        res.status(500).json({ error: 'Failed to initialize wallet' });
    }
});

// Get current balance
router.get('/balance/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        let { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', userId)
            .single();

        // Auto-create user if missing (JIT initialization)
        if (!user && !error) {
            // This case might not happen if error is 406 (single() and no data) or if we check error
        }

        if (error && error.code === 'PGRST116') { // PGRST116 is PostgreSQL code for "no rows returned"
            console.log(`👤 New user detected: ${userId}. Auto-creating...`);
            const { data: newUser, error: insertError } = await supabase
                .from('users')
                .insert({
                    id: userId,
                    balance: 0,
                    public_key: 'PENDING_INITIALIZATION'
                })
                .select()
                .single();

            if (insertError) throw insertError;
            user = newUser;
        } else if (error) {
            throw error;
        }

        res.json({ balance: user.balance });
    } catch (err) {
        console.error('Balance Fetch Error:', err);
        res.status(500).json({ error: 'Failed to fetch balance' });
    }
});

// Fund wallet (Simulated)
router.post('/fund', async (req, res) => {
    const { user_id, amount } = req.body;
    if (!user_id || amount === undefined) return res.status(400).json({ error: 'Missing parameters' });

    try {
        // Fetch current balance
        let { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', user_id)
            .single();

        if (error && error.code === 'PGRST116') {
            const { data: newUser, error: insertError } = await supabase
                .from('users')
                .insert({
                    id: user_id,
                    public_key: 'PENDING_INITIALIZATION',
                    balance: amount
                })
                .select()
                .single();

            if (insertError) throw insertError;
            user = newUser;
        } else if (error) {
            throw error;
        } else {
            // Increment balance
            const newBalance = (user.balance || 0) + amount;
            const { data: updatedUser, error: updateError } = await supabase
                .from('users')
                .update({ balance: newBalance })
                .eq('id', user_id)
                .select()
                .single();

            if (updateError) throw updateError;
            user = updatedUser;
        }

        res.json({ balance: user.balance });
    } catch (err) {
        console.error('Fund Error:', err);
        res.status(500).json({ error: 'Failed to fund wallet' });
    }
});

// Generate Balance Certificate (Load Tip Wallet)
router.post('/certificate', async (req, res) => {
    const { user_id, device_id, amount } = req.body;
    if (!user_id || !device_id || amount === undefined) return res.status(400).json({ error: 'Missing parameters' });

    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', user_id)
            .single();

        if (error || !user) return res.status(404).json({ error: 'User not found' });

        if (user.balance < amount) {
            return res.status(400).json({ error: 'Insufficient balance on server' });
        }

        // Deduct from server balance (Online -> Offline)
        const newBalance = user.balance - amount;
        const { error: updateError } = await supabase
            .from('users')
            .update({ balance: newBalance })
            .eq('id', user_id);

        if (updateError) throw updateError;

        const certificate = {
            user_id: user.id,
            device_id: device_id,
            tip_wallet_balance: amount,
            timestamp: new Date().toISOString(),
            nonce: Math.random().toString(36).substring(7),
            expiration: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        };

        const dataToSign = [
            certificate.user_id,
            certificate.device_id,
            certificate.tip_wallet_balance,
            certificate.timestamp,
            certificate.nonce,
            certificate.expiration
        ].join('|');

        const signature = CryptoService.sign(dataToSign);

        res.json({ ...certificate, signature });
    } catch (err) {
        console.error('Certificate Error:', err);
        res.status(500).json({ error: 'Failed to generate certificate' });
    }
});

export default router;

