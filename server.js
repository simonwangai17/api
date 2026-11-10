const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';
const MPESA_BASE_URL = isProduction ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const transactions = {};

app.get('/', (req, res) => res.json({ status: 'Backend running' }));

app.get('/api/balance/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { data, error } = await supabase.from('orders').select('price').eq('recipient_phone', phone);
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ success: false, error: 'No active package found for this number.' });

    const totalSpent = data.reduce((sum, order) => sum + Number(order.price), 0);
    res.json({ success: true, balance: { data: (totalSpent / 25).toFixed(1) + ' GB', sms: Math.floor(totalSpent / 2) + ' SMS', airtime: 'KES ' + (totalSpent * 0.05).toFixed(2) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch balance.' });
  }
});

async function getAccessToken() {
  const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get(`${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
  return res.data.access_token;
}

app.post('/api/mpesa/stkpush', async (req, res) => {
  try {
    const { recipientPhone, mpesaPhone, amount, bundleName, network } = req.body;
    
    if (!recipientPhone || !mpesaPhone) return res.status(400).json({ success: false, error: 'Missing phone numbers' });

    const token = await getAccessToken();
    
    let formattedPayerPhone = mpesaPhone.replace(/\D/g, '');
    if (formattedPayerPhone.startsWith('0')) formattedPayerPhone = '254' + formattedPayerPhone.slice(1);

    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
    const password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');

    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerBuyGoodsOnline',
      Amount: Math.round(amount),
      PartyA: formattedPayerPhone,
      PartyB: '8189020', 
      PhoneNumber: formattedPayerPhone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: 'DataStore',
      TransactionDesc: bundleName ? bundleName.substring(0, 13) : 'Data Bundle'
    };

    const response = await axios.post(`${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`, payload, { headers: { Authorization: `Bearer ${token}` } });

    transactions[response.data.CheckoutRequestID] = { 
      status: 'pending', 
      recipientPhone: recipientPhone, 
      mpesaPhone: formattedPayerPhone, 
      amount: Math.round(amount), 
      bundleName: bundleName, 
      network: network
    };
    
    res.json({ success: true, checkoutId: response.data.CheckoutRequestID });
  } catch (error) {
    res.status(500).json({ success: false, error: error.response?.data?.errorMessage || error.message });
  }
});

app.post('/api/mpesa/callback', async (req, res) => {
  const callbackData = req.body.Body?.stkCallback;
  if (!callbackData) return res.status(400).send('Invalid');
  
  const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = callbackData;

  if (ResultCode === 0) {
    const receipt = CallbackMetadata?.Item?.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
    const amountPaid = CallbackMetadata?.Item?.find(item => item.Name === 'Amount')?.Value;
    
    const txDetails = transactions[CheckoutRequestID] || {};
    
    const finalRecipient = txDetails.recipientPhone || 'Unknown';
    const finalBundle = txDetails.bundleName || 'Unknown';
    const finalNetwork = txDetails.network || 'safaricom';
    const finalMpesa = txDetails.mpesaPhone || 'Unknown';

    transactions[CheckoutRequestID] = { status: 'success', receipt };

    console.log(`💾 Saving: ${finalBundle} (${finalNetwork}) to ${finalRecipient} via ${finalMpesa}`);
    const { error } = await supabase.from('orders').insert({
      bundle_name: finalBundle,
      network: finalNetwork,
      recipient_phone: finalRecipient,
      mpesa_phone: finalMpesa,
      receipt: receipt,
      price: amountPaid
    });

    if (error) console.error('❌ SUPABASE ERROR:', error);
    else console.log(`✅ Order saved: ${receipt}`);
  } else {
    transactions[CheckoutRequestID] = { status: 'failed', reason: ResultDesc };
  }
  
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.get('/api/mpesa/status/:checkoutId', (req, res) => {
  res.json(transactions[req.params.checkoutId] || { status: 'unknown' });
});

app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));
