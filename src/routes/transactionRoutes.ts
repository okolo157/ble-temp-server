import { Router } from 'express';
import { supabase } from '../db/supabaseClient.js';
import CryptoService from '../services/CryptoService.js';

const router = Router();

// Sync offline transactions
router.post('/sync', async (req, res) => {
    const { certificate, transactions, user_id } = req.body;

    if (!transactions || !Array.isArray(transactions)) {
        return res.status(400).json({ error: 'Missing transactions' });
    }

    if (!certificate && !user_id) {
        return res.status(400).json({ error: 'Missing user identification (certificate or user_id)' });
    }

    try {
        // 1. Verify Certificate Signature (if provided)
        if (certificate) {
            const certToVerify = [
                certificate.user_id,
                certificate.device_id,
                certificate.tip_wallet_balance,
                certificate.timestamp,
                certificate.nonce,
                certificate.expiration
            ].join('|');

            const isCertValid = CryptoService.verify(certToVerify, certificate.signature, CryptoService.getPublicKey());
            if (!isCertValid) return res.status(401).json({ error: 'Invalid certificate' });
        }

        // 2. Process Transactions
        const results = [];
        let totalSpent = 0;

        for (const tx of transactions) {
            // Always count toward totalSpent if part of this sync session
            totalSpent += tx.amount;
            results.push(tx.transaction_id);

            // Check if already processed
            const { data: existing, error: checkError } = await supabase
                .from('transactions')
                .select('id')
                .eq('id', tx.transaction_id)
                .maybeSingle();

            if (checkError) throw checkError;
            if (existing) continue;

            // Determine sender_id
            let senderId = tx.sender_user_id;
            if (!senderId && certificate) {
                if (certificate.device_id === tx.sender_device_id) {
                    senderId = certificate.user_id;
                }
            }
            if (!senderId) senderId = tx.sender_device_id;

            // Record transaction
            if (!tx.sender_signature) {
                console.warn(`[Sync] Skipping DB record for ${tx.transaction_id} - missing sender_signature`);
                continue;
            }

            const receiverId = tx.receiver_user_id || tx.receiver_device_id || 'unknown';

            const { error: insertTxError } = await supabase
                .from('transactions')
                .insert({
                    id: tx.transaction_id,
                    sender_id: senderId,
                    receiver_id: receiverId,
                    amount: tx.amount,
                    signature: tx.sender_signature,
                    payload: tx
                });

            if (insertTxError) throw insertTxError;

            // Increment receiver's balance
            if (receiverId && receiverId !== 'unknown') {
                const { data: receiver, error: fetchReceiverError } = await supabase
                    .from('users')
                    .select('balance')
                    .eq('id', receiverId)
                    .single();

                if (fetchReceiverError && fetchReceiverError.code !== 'PGRST116') throw fetchReceiverError;

                if (receiver) {
                    const newBalance = (receiver.balance || 0) + tx.amount;
                    await supabase
                        .from('users')
                        .update({ balance: newBalance })
                        .eq('id', receiverId);
                } else {
                    await supabase
                        .from('users')
                        .insert({
                            id: receiverId,
                            balance: tx.amount,
                            public_key: 'PENDING_INITIALIZATION'
                        });
                }
            }
        }

        // 3. Handle Unspent Portion (Keep the Change)
        let unspent = 0;
        let newCertificate = null;

        if (certificate) {
            unspent = certificate.tip_wallet_balance - totalSpent;
            if (unspent > 0) {
                // Generate a NEW certificate for the unspent amount
                // This allows the user to keep funds offline ("Change")
                const timestamp = new Date().toISOString();
                const nonce = Math.floor(Math.random() * 1000000000).toString(); // Simple nonce
                const expiration = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(); // 30 days

                // Construct certificate data string
                const certData = [
                    certificate.user_id,
                    certificate.device_id,
                    unspent,
                    timestamp,
                    nonce,
                    expiration
                ].join('|');

                const signature = CryptoService.sign(certData);

                newCertificate = {
                    user_id: certificate.user_id,
                    device_id: certificate.device_id,
                    tip_wallet_balance: unspent,
                    timestamp,
                    nonce,
                    expiration,
                    signature
                };
            }
        }

        const syncingUserId = certificate ? certificate.user_id : user_id;
        const { data: finalUser, error: finalUserError } = await supabase
            .from('users')
            .select('balance')
            .eq('id', syncingUserId)
            .single();

        res.json({
            status: 'ok',
            processed: results,
            new_certificate: newCertificate, // Return the change certificate
            total_spent: totalSpent,
            balance: finalUser ? finalUser.balance : 0
        });
    } catch (err) {
        console.error('Sync error:', err);
        res.status(500).json({ error: 'Sync failed' });
    }
});

export default router;

