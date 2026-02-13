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
            // Check if already processed
            const { data: existing, error: checkError } = await supabase
                .from('transactions')
                .select('id')
                .eq('id', tx.transaction_id)
                .maybeSingle();

            if (checkError) throw checkError;
            if (existing) continue;

            // Determine sender_id
            // 1. Explicit sender_user_id in transaction (Best)
            // 2. Certificate user_id (Only if syncing user IS the sender)
            // 3. Fallback to device_id (Will fail FK if not mapped, but better than wrong user)
            let senderId = tx.sender_user_id;

            if (!senderId && certificate) {
                // Only use certificate user_id if the device ID matches
                if (certificate.device_id === tx.sender_device_id) {
                    senderId = certificate.user_id;
                }
            }

            if (!senderId) {
                senderId = tx.sender_device_id;
            }

            // Record transaction
            if (!tx.sender_signature) {
                console.warn(`[Sync] Skipping transaction ${tx.transaction_id} - missing sender_signature`);
                results.push(tx.transaction_id); // Still mark as processed so client clears it
                continue;
            }

            // Record transaction
            const receiverId = tx.receiver_user_id || tx.receiver_device_id || 'unknown';

            if (!tx.sender_signature) {
                console.warn(`[Sync] Skipping transaction ${tx.transaction_id} - missing sender_signature`);
                results.push(tx.transaction_id); // Still mark as processed so client clears it
                continue;
            }

            const { error: insertTxError } = await supabase
                .from('transactions')
                .insert({
                    id: tx.transaction_id,
                    sender_id: senderId,
                    receiver_id: receiverId,
                    amount: tx.amount,
                    signature: tx.sender_signature,
                    payload: tx // Store the full object (Supabase 'jsonb' column recommended)
                });

            if (insertTxError) throw insertTxError;

            // Increment receiver's balance
            if (receiverId && receiverId !== 'unknown') {
                // We need to fetch and increment as Supabase doesn't have a direct "increment" method via RPC or direct call without a custom function
                // Alternative: Use an RPC call if the user creates a function, but for now we'll do fetch-then-update
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
                    // Create receiver if they don't exist
                    await supabase
                        .from('users')
                        .insert({
                            id: receiverId,
                            balance: tx.amount,
                            public_key: 'PENDING_INITIALIZATION'
                        });
                }
            }

            totalSpent += tx.amount;
            results.push(tx.transaction_id);
        }

        // 3. Refund Unspent Portion of the Certificate
        let unspent = 0;
        if (certificate) {
            unspent = certificate.tip_wallet_balance - totalSpent;
            if (unspent > 0) {
                const { data: user, error: fetchUserError } = await supabase
                    .from('users')
                    .select('balance')
                    .eq('id', certificate.user_id)
                    .single();

                if (fetchUserError) throw fetchUserError;

                const newBalance = (user.balance || 0) + unspent;
                await supabase
                    .from('users')
                    .update({ balance: newBalance })
                    .eq('id', certificate.user_id);
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
            refunded: unspent,
            total_spent: totalSpent,
            balance: finalUser ? finalUser.balance : 0
        });
    } catch (err) {
        console.error('Sync error:', err);
        res.status(500).json({ error: 'Sync failed' });
    }
});

export default router;

